"""临时:导出中国艺人头像样本到 /tmp/artist-sample-cn 供人工检查。"""
import asyncio, os, re, io, json
import asyncpg
from minio import Minio

OUT = "/tmp/artist-sample-cn"
BUCKET = "musicmap-artists"

def s3():
    return Minio(os.getenv("MINIO_ENDPOINT","minio:9000"),
                 access_key=os.getenv("MINIO_ACCESS_KEY","musicmap"),
                 secret_key=os.getenv("MINIO_SECRET_KEY","change_me_in_real_env"),
                 secure=False)

def safe(s):
    return re.sub(r'[^\w一-鿿.-]', '_', str(s))[:40]

async def main():
    os.makedirs(OUT, exist_ok=True)
    dsn = os.getenv("DATABASE_URL","postgresql://musicmap:change_me_in_real_env@postgis:5432/musicmap").replace("postgresql+asyncpg://","postgresql://")
    pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4)
    rows = await pool.fetch("""
        (SELECT mbid::text, name, deezer_name, deezer_fans, 'A_highfan' AS grp
         FROM app.artists WHERE deezer_status='matched' AND country_iso IN ('CN','TW','HK')
         ORDER BY deezer_fans DESC NULLS LAST LIMIT 20)
        UNION ALL
        (SELECT mbid::text, name, deezer_name, deezer_fans, 'B_namematch' AS grp
         FROM app.artists WHERE deezer_status='matched' AND country_iso IN ('CN','TW','HK')
           AND lower(name)=lower(deezer_name)
         ORDER BY deezer_fans DESC NULLS LAST LIMIT 20)
    """)
    cli = s3()
    manifest = []
    for i, r in enumerate(rows):
        mbid = r["mbid"]
        key = f"{mbid[:2]}/{mbid}.jpg"
        fname = f"{r['grp']}__{i:02d}__{safe(r['name'])}__TO__{safe(r['deezer_name'])}__fans{r['deezer_fans']}.jpg"
        try:
            resp = cli.get_object(BUCKET, key)
            data = resp.read(); resp.close(); resp.release_conn()
            with open(os.path.join(OUT, fname), "wb") as f:
                f.write(data)
            manifest.append({"orig": r["name"], "deezer": r["deezer_name"], "fans": r["deezer_fans"], "grp": r["grp"], "file": fname, "bytes": len(data)})
        except Exception as e:
            manifest.append({"orig": r["name"], "deezer": r["deezer_name"], "err": str(e)[:60]})
    with open(os.path.join(OUT, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    ok = sum(1 for m in manifest if "file" in m)
    print(f"exported {ok}/{len(rows)} -> {OUT}")
    await pool.close()

asyncio.run(main())
