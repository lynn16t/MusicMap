# 自定义 PostGIS 镜像:在官方镜像基础上加入 shp2pgsql 等 CLI 工具
# 官方 postgis/postgis:16-3.4 只有数据库 server,不带 shp2pgsql / raster2pgsql,
# 而 Phase 3 需要把 Natural Earth shp 导进来,所以在这一层把它装上。
FROM postgis/postgis:16-3.4

# 切到阿里云镜像源,免被墙;再装 postgis(含 shp2pgsql)
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com/debian-security|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null \
    && apt-get update -qq \
    && apt-get install -y -qq postgis \
    && rm -rf /var/lib/apt/lists/*
