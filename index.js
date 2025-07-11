/**
 * 计算面状或多面状GeoJSON在指定投影下覆盖的瓦片坐标
 * @param {Object} geojson - 面状或多面状GeoJSON对象
 * @param {number|Array<number>} zoomLevels - 目标缩放级别或缩放级别数组
 * @param {boolean} useWebMercator - 是否使用Web Mercator投影（true）或WGS84经纬度投影（false）
 * @returns {Object|Array<Object>} - 当传入单个zoom时返回瓦片数组，传入多个zoom时返回各层级结果的映射
 */
function calculateTiles(geojson, zoomLevels, useWebMercator = true) {
    // 地球半径（单位：米）
    const R = 6378137;
    // 瓦片大小（像素）
    const TILE_SIZE = 256;

    // 处理单个缩放级别或多个缩放级别
    const zoomArray = Array.isArray(zoomLevels) ? zoomLevels : [zoomLevels];

    // 提取所有坐标点
    let allCoordinates = [];
    let geometry;

    // 处理完整GeoJSON或仅geometry对象
    if (geojson.type === "Feature") {
        geometry = geojson.geometry;
    } else if (geojson.type === "FeatureCollection") {
        // 处理FeatureCollection中的所有面状要素
        geojson.features.forEach((feature) => {
            if (
                feature.geometry &&
                (feature.geometry.type === "Polygon" ||
                    feature.geometry.type === "MultiPolygon")
            ) {
                const coords = extractCoordinatesFromGeometry(feature.geometry);
                allCoordinates = allCoordinates.concat(coords);
            }
        });
        // 如果处理了FeatureCollection，直接跳到计算边界框
    } else {
        // 假设是geometry对象
        geometry = geojson;
    }

    // 处理单个Geometry对象
    if (geometry) {
        if (geometry.type === "Polygon") {
            allCoordinates = extractCoordinatesFromPolygon(geometry.coordinates);
        } else if (geometry.type === "MultiPolygon") {
            geometry.coordinates.forEach((polygon) => {
                allCoordinates = allCoordinates.concat(
                    extractCoordinatesFromPolygon(polygon)
                );
            });
        } else {
            throw new Error(
                "输入的GeoJSON必须包含Polygon或MultiPolygon类型的geometry"
            );
        }
    }

    // 计算边界框（只计算一次，供所有缩放级别使用）
    let minLng = Infinity,
        minLat = Infinity;
    let maxLng = -Infinity,
        maxLat = -Infinity;

    allCoordinates.forEach(([lng, lat]) => {
        minLng = Math.min(minLng, lng);
        minLat = Math.min(minLat, lat);
        maxLng = Math.max(maxLng, lng);
        maxLat = Math.max(maxLat, lat);
    });

    // 为每个缩放级别计算瓦片坐标
    const results = {};
    zoomArray.forEach((zoom) => {
        const tiles = useWebMercator
          ? calculateWebMercatorTiles(
                minLng,
                minLat,
                maxLng,
                maxLat,
                zoom,
                R,
                TILE_SIZE
            )
          : calculateWgs84Tiles(minLng, minLat, maxLng, maxLat, zoom);

        results[zoom] = tiles;
    });

    // 根据输入类型返回结果
    return Array.isArray(zoomLevels) ? results : results[zoomLevels[0]];
}

/**
 * 计算Web Mercator投影下的瓦片坐标
 */
function calculateWebMercatorTiles(
    minLng,
    minLat,
    maxLng,
    maxLat,
    zoom,
    R,
    TILE_SIZE
) {
    // 转换边界框坐标为Web墨卡托
    const minX = minLng * (Math.PI / 180) * R;
    const maxX = maxLng * (Math.PI / 180) * R;

    // 注意：纬度需要进行sinh/cosh转换
    const yMin =
        Math.log(Math.tan(Math.PI / 4 + (minLat * (Math.PI / 180)) / 2)) * R;
    const yMax =
        Math.log(Math.tan(Math.PI / 4 + (maxLat * (Math.PI / 180)) / 2)) * R;

    const minY = Math.min(yMin, yMax);
    const maxY = Math.max(yMin, yMax);

    // 计算瓦片坐标范围
    const worldSize = 2 * Math.PI * R;
    const tileCount = 1 << zoom; // 2^zoom

    const minTileX = Math.floor((minX / worldSize + 0.5) * tileCount);
    const maxTileX = Math.floor((maxX / worldSize + 0.5) * tileCount);
    // 注意：Y轴在瓦片坐标系中是向下的，与墨卡托Y方向相反
    const minTileY = Math.floor((0.5 - maxY / worldSize) * tileCount);
    const maxTileY = Math.floor((0.5 - minY / worldSize) * tileCount);

    // 生成瓦片坐标数组
    const tiles = [];
    for (let x = minTileX; x <= maxTileX; x++) {
        for (let y = minTileY; y <= maxTileY; y++) {
            tiles.push({ x, y, z: zoom });
        }
    }

    return tiles;
}

/**
 * 计算WGS84经纬度投影下的瓦片坐标（TMS规范）
 */
function calculateWgs84Tiles(minLng, minLat, maxLng, maxLat, zoom) {
    // 限制纬度范围（-85.0511到85.0511，对应Web墨卡托的范围）
    minLat = Math.max(-85.0511, Math.min(85.0511, minLat));
    maxLat = Math.max(-85.0511, Math.min(85.0511, maxLat));

    // 标准化经度到[-180, 180]
    minLng = ((((minLng + 180) % 360) + 360) % 360) - 180;
    maxLng = ((((maxLng + 180) % 360) + 360) % 360) - 180;

    // 确保minLng小于maxLng
    if (minLng > maxLng) {
        // 处理跨180度经线的情况
        const tilesWest = calculateWgs84Tiles(minLng, minLat, 180, maxLat, zoom);
        const tilesEast = calculateWgs84Tiles(-180, minLat, maxLng, maxLat, zoom);
        return [...tilesWest, ...tilesEast];
    }

    // 计算瓦片数量（每层级的瓦片数为2^zoom x 2^zoom）
    const tileCount = 1 << zoom;

    // 计算瓦片坐标
    const minTileX = Math.floor(((minLng + 180) / 360) * tileCount);
    const maxTileX = Math.floor(((maxLng + 180) / 360) * tileCount);

    // 注意：TMS规范中，纬度方向是从南到北（0在南极，2^zoom-1在北极）
    // 而经纬度中，纬度是从北到南（90在北极，-90在南极）
    const minTileY = Math.floor(((90 - maxLat) / 180) * tileCount);
    const maxTileY = Math.floor(((90 - minLat) / 180) * tileCount);

    // 生成瓦片坐标数组
    const tiles = [];
    for (let x = minTileX * 2; x <= maxTileX * 2; x++) {
        for (let y = minTileY; y <= maxTileY; y++) {
            tiles.push({ x, y, z: zoom });
        }
    }

    return tiles;
}

/**
 * 从多边形坐标中提取所有点
 * @param {Array} coordinates - 多边形坐标
 * @returns {Array} - 点数组 [[lng, lat], ...]
 */
function extractCoordinatesFromPolygon(coordinates) {
    let points = [];
    // 处理外环和内环
    coordinates.forEach((ring) => {
        points = points.concat(ring);
    });
    return points;
}

/**
 * 从Geometry对象中提取坐标
 * @param {Object} geometry - GeoJSON Geometry对象
 * @returns {Array} - 坐标点数组
 */
function extractCoordinatesFromGeometry(geometry) {
    let coords = [];
    if (geometry.type === "Polygon") {
        coords = extractCoordinatesFromPolygon(geometry.coordinates);
    } else if (geometry.type === "MultiPolygon") {
        geometry.coordinates.forEach((polygon) => {
            coords = coords.concat(extractCoordinatesFromPolygon(polygon));
        });
    }
    return coords;
}

const testPolygon1 = {
    type: "FeatureCollection",
    name: "bj",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: [
        {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [116.374842044447277, 39.928336620101462],
                        [116.428756054000047, 39.929049441227839],
                        [116.426896950222343, 39.905522425131416],
                        [116.37948980389146, 39.904096285603835],
                        [116.37948980389146, 39.904096285603835],
                        [116.37948980389146, 39.904096285603835],
                        [116.374842044447277, 39.928336620101462],
                    ],
                ],
            },
        },
    ],
};

const results2 = calculateTiles(testPolygon1, [16]);
console.log(results2[16]); 