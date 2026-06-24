"""
Phase 2 / Spotify ETL
═════════════════════════════════════════════════════════════════

对 app.albums 里 2010-2025 + release_count>=2 的子集:
  1. 用 (artist, title) 在 Spotify 搜专辑
  2. 取第一个最匹配的 album → 拿 popularity + image_url + spotify_id
  3. 写回 app.albums

可断点续跑:跳过 spotify_status != 'unknown' 的行。

用法(在 backend 容器内):
    docker compose exec backend python /etl/phase2_spotify.py --limit 100
    docker compose exec backend python /etl/phase2_spotify.py
    docker compose exec backend python /etl/phase2_spotify.py --retry-errors

需要环境变量:
    SPOTIFY_CLIENT_ID
    SPOTIFY_CLIENT_SECRET
(写在 .env,docker-compose 会注入到 backend 容器)
"""
import argparse
import asyncio
import base64
import os
import signal
import time
from typing import Optional

import asyncpg
import httpx

# ─── 配置 ────────────────────────────────────────────────────
def _db_dsn() -> str:
    url = os.getenv("DATABASE_URL", "postgresql://musicmap:change_me@postgis:5432/musicmap")
    return url.replace("postgresql+asyncpg://", "postgresql://")
DB_DSN = _db_dsn()

CLIENT_ID = os.environ["SPOTIFY_CLIENT_ID"]
CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]

TOKEN_URL  = "https://accounts.spotify.com/api/token"
SEARCH_URL = "https://api.spotify.com/v1/search"

# Phase 2 配置:2010-2025 + release_count>=2
DEFAULT_WHERE = "release_year BETWEEN 2010 AND 2025"

TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# ─── Ctrl-C ──────────────────────────────────────────────────
shutdown = False
def _sig(*_):
    global shutdown
    shutdown = True
    print("\n[!] shutdown requested, finishing inflight then exit...", flush=True)
signal.signal(signal.SIGINT, _sig)
signal.signal(signal.SIGTERM, _sig)


# ─── 看门狗:stats[processed] N 秒不涨就硬退出 ─────────────
# (asyncpg pool 死锁 / httpx 连接卡死时主循环看不出来,得靠这个兜底)
async def watchdog(stats: dict, idle_threshold: int = 300, check_interval: int = 60):
    """
    每 check_interval 秒看一眼 processed 计数,>idle_threshold 秒没涨就 os._exit(2)。
    收到 shutdown 信号后阈值降到 30s(防止 pool.close() 也卡住)。
    冷启动给 90s 宽限期。
    """
    await asyncio.sleep(90)
    last_count = stats["processed"]
    last_advance = time.time()
    while True:
        await asyncio.sleep(check_interval)
        now = stats["processed"]
        if now > last_count:
            last_count = now
            last_advance = time.time()
            continue
        idle = time.time() - last_advance
        threshold = 30 if shutdown else idle_threshold
        if idle >= threshold:
            print(
                f"\n[WATCHDOG] {idle:.0f}s no progress (threshold={threshold}s, "
                f"shutdown={shutdown}), force exit",
                flush=True,
            )
            os._exit(2)
        else:
            print(
                f"[WATCHDOG] {idle:.0f}s no progress, will kill at {threshold}s",
                flush=True,
            )


# ─── OAuth Client Credentials Flow ─────────────────────────
class SpotifyAuth:
    """自动管理 token,失效自动续。"""
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.token: Optional[str] = None
        self.expires_at: float = 0.0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        async with self._lock:
            if self.token and time.time() < self.expires_at - 60:
                return self.token
            auth = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
            r = await self.client.post(
                TOKEN_URL,
                headers={"Authorization": f"Basic {auth}",
                         "Content-Type": "application/x-www-form-urlencoded"},
                data={"grant_type": "client_credentials"},
            )
            r.raise_for_status()
            j = r.json()
            self.token = j["access_token"]
            self.expires_at = time.time() + j["expires_in"]
            print(f"[+] new spotify token, expires in {j['expires_in']}s")
            return self.token


# ─── 字符串清洗(增加匹配率) ───────────────────────────
def _clean(s: str) -> str:
    """剥除一些干扰匹配的小细节"""
    s = s.replace("(", " ").replace(")", " ")
    s = s.replace("[", " ").replace("]", " ")
    s = s.replace(":", " ").replace("「", " ").replace("」", " ")
    return " ".join(s.split())


# ─── 单张匹配 ──────────────────────────────────────────────
async def match_one(
    client: httpx.AsyncClient,
    auth: SpotifyAuth,
    sem: asyncio.Semaphore,
    pool: asyncpg.Pool,
    row: asyncpg.Record,
    stats: dict,
):
    async with sem:
        if shutdown:
            return
        mbid = row["mbid"]
        artist = row["primary_artist_name"]
        title = row["title"]
        year = row["release_year"]

        # 构造查询:artist:"..." album:"..." year:YYYY
        q = f'artist:"{_clean(artist)}" album:"{_clean(title)}" year:{year-1}-{year+1}'

        result_status = "error"
        spotify_id = None
        popularity = None
        image_url = None
        match_score = None

        try:
            token = await auth.get_token()
            r = await client.get(
                SEARCH_URL,
                headers={"Authorization": f"Bearer {token}"},
                params={"q": q, "type": "album", "limit": 5, "market": "US"},
            )
            if r.status_code == 401:
                # token 过期了一点点
                auth.token = None
                token = await auth.get_token()
                r = await client.get(
                    SEARCH_URL,
                    headers={"Authorization": f"Bearer {token}"},
                    params={"q": q, "type": "album", "limit": 5, "market": "US"},
                )
            if r.status_code == 429:
                # rate-limited,sleep retry-after
                retry_after = int(r.headers.get("Retry-After", "5"))
                stats["rate_limited"] += 1
                await asyncio.sleep(retry_after + 1)
                token = await auth.get_token()
                r = await client.get(
                    SEARCH_URL,
                    headers={"Authorization": f"Bearer {token}"},
                    params={"q": q, "type": "album", "limit": 5, "market": "US"},
                )

            if r.status_code != 200:
                stats["http_errors"] += 1
                result_status = "error"
            else:
                items = r.json().get("albums", {}).get("items", [])
                if not items:
                    # 退一步:用更宽松的搜索(去掉 year, 去掉双引号)
                    q2 = f'{_clean(artist)} {_clean(title)}'
                    r2 = await client.get(
                        SEARCH_URL,
                        headers={"Authorization": f"Bearer {token}"},
                        params={"q": q2, "type": "album", "limit": 5, "market": "US"},
                    )
                    if r2.status_code == 200:
                        items = r2.json().get("albums", {}).get("items", [])

                if not items:
                    result_status = "no_match"
                    stats["no_match"] += 1
                else:
                    # 取第一条 — search 结果已经直接带 images + id + name
                    # (Spotify 2024 年下线了 popularity 字段,不再走 detail endpoint)
                    best = items[0]
                    spotify_id = best["id"]
                    if best.get("images"):
                        # images 按尺寸降序排,第一个最大(640×640)
                        image_url = best["images"][0]["url"]
                    # 匹配度:标题字符串字符前缀对齐比例
                    s_title = best.get("name", "").lower()
                    t_title = title.lower()
                    match_score = (
                        sum(1 for a, b in zip(s_title, t_title) if a == b)
                        / max(len(s_title), len(t_title), 1)
                    )
                    result_status = "matched"
                    stats["matched"] += 1
                    # popularity 保持 None — 该字段已被 Spotify deprecated

        except httpx.RequestError:
            stats["network_errors"] += 1
            result_status = "error"
        except Exception as e:
            stats["other_errors"] += 1
            result_status = "error"

        # 写库 — pool.acquire 和 execute 都加超时,防止 PG 链接静默死掉导致协程卡死
        try:
            async with pool.acquire(timeout=10) as conn:
                await asyncio.wait_for(
                    conn.execute(
                        """
                        UPDATE app.albums
                        SET spotify_status = $1,
                            spotify_id = $2,
                            spotify_popularity = $3,
                            spotify_image_url = $4,
                            spotify_match_score = $5
                        WHERE mbid = $6
                        """,
                        result_status, spotify_id, popularity, image_url, match_score, mbid,
                    ),
                    timeout=10,
                )
        except (asyncio.TimeoutError, Exception) as e:
            print(f"[!] DB update failed for {mbid}: {type(e).__name__}: {e}", flush=True)

        stats["processed"] += 1
        if stats["processed"] % 200 == 0:
            _progress(stats)


def _progress(stats: dict):
    elapsed = time.time() - stats["t0"]
    rate = stats["processed"] / max(elapsed, 0.01)
    pct = stats["processed"] * 100 / max(stats["total"], 1)
    eta_h = (stats["total"] - stats["processed"]) / max(rate, 0.01) / 3600
    print(
        f"  {stats['processed']:>7}/{stats['total']} ({pct:5.1f}%) | "
        f"matched={stats['matched']} no_match={stats['no_match']} | "
        f"{rate:5.1f}/s | ETA {eta_h:.1f}h",
        flush=True,
    )


# ─── 主流程 ───────────────────────────────────────────────
async def main(args):
    global shutdown
    if args.retry_errors:
        cond = "spotify_status = 'error'"
    else:
        cond = f"spotify_status = 'unknown' AND ({DEFAULT_WHERE})"
    if args.where:
        cond = f"({cond}) AND ({args.where})"
    limit = f"LIMIT {args.limit}" if args.limit else ""

    pool = await asyncpg.create_pool(DB_DSN, min_size=2, max_size=10)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT mbid::text AS mbid, title, primary_artist_name, release_year
            FROM app.albums
            WHERE {cond}
            ORDER BY mbid
            {limit}
            """
        )
    total = len(rows)
    print(f"[i] {total} albums to query Spotify (concurrency={args.concurrency})")
    if total == 0:
        return

    stats = {
        "total": total, "processed": 0,
        "matched": 0, "no_match": 0,
        "http_errors": 0, "network_errors": 0,
        "detail_errors": 0, "rate_limited": 0, "other_errors": 0,
        "t0": time.time(),
    }
    sem = asyncio.Semaphore(args.concurrency)

    limits = httpx.Limits(
        max_connections=args.concurrency * 2,
        max_keepalive_connections=args.concurrency,
    )
    deadline = (time.time() + args.max_hours * 3600) if args.max_hours else None
    if deadline:
        print(f"[i] will gracefully stop in {args.max_hours} hours")

    async with httpx.AsyncClient(timeout=TIMEOUT, limits=limits) as client:
        auth = SpotifyAuth(client)
        # 看门狗后台跑,主循环不 await 它(它要么自杀,要么活到进程退出)
        asyncio.create_task(watchdog(stats))
        tasks = [
            asyncio.create_task(match_one(client, auth, sem, pool, r, stats))
            for r in rows
        ]
        for t in asyncio.as_completed(tasks):
            await t
            # 时限检查
            if deadline and time.time() >= deadline:
                shutdown = True
                print(f"\n[!] max-hours hit, gracefully stopping...")
            if shutdown:
                for tt in tasks:
                    if not tt.done():
                        tt.cancel()
                break

    print("\n─── 完成 ──────────────────────────────────")
    _progress(stats)
    print(f"  match rate: {stats['matched']*100/max(stats['processed'],1):.1f}%")
    await pool.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--concurrency", type=int, default=10)
    p.add_argument("--retry-errors", action="store_true")
    p.add_argument("--where", type=str, default=None, help="额外 WHERE 条件(AND)")
    p.add_argument("--max-hours", type=float, default=None,
                   help="跑 N 小时后优雅停止(DB 已经持续写入,下次启动自动续跑)")
    args = p.parse_args()
    asyncio.run(main(args))
