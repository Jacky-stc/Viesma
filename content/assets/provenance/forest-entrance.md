# Forest Entrance 原創素材來源

VF.1 由 Viesma 專案擁有者提供六張自行生成的暖橘手繪風森林 PNG，供本專案的 Forest Entrance 視覺實驗。專案內授權分類為 `project-owned`，署名 `Viesma · Forest Entrance`。生成工具、版本、提示詞、seed 與輸入素材明細未隨交件提供。可重建本次開發預覽的固定輸入是交件的本機原始 PNG 與登錄的 SHA-256。

- L0、L1、L2、L3、L5 的開發資產登錄含原始尺寸與摘要。Vite 開發伺服器逐位元組供應審查過的 PNG。 [開發登錄](../experimental-parallax.json)
- L4 的 `forest-terrain.png` 是獨立圖塊來源。SHA-256 為 `d8f651b534da1e0f9a86a967019d49ce992ab6a78b1ae9effc003b81213af248`。VF.2 依明列座標裁切、等比縮至 32 px、融合拼接端的 3 px 並外擴 2 px，另存開發圖集。 [六張原始 PNG](../../../art/source/environments/forest-entrance/) · [切片清單](../forest-terrain-slices.json) · [衍生圖集登錄](../experimental-terrain.json)
- L0–L3、L5 使用原始 PNG 與 alpha，L4 使用衍生圖集。授權與來源紀錄提供於開發版 `game-assets/attribution.txt`。 [VF.1 素材稽核](../../../docs/evidence/VF1.md) · [VF.2 切片稽核](../../../docs/evidence/VF2.md)
- VF.2.1b 的四張自然地形 PNG 由 Viesma 專案擁有者提供，沿用 `project-owned` 與署名 `Viesma · Forest Entrance`。原圖與各自的 SHA-256 隨交件保存。Pillow 以指定區域和草面錨點生成半解析度圖集，清除極低 alpha 雜點，於內接點做局部預乘 alpha 混合並外擴取樣邊界。 [原圖](../../../art/source/environments/forest-entrance/organic-terrain/) · [切片清單](../../../apps/client/src/rendering/forest-organic-terrain-slices.json) · [衍生圖集登錄](../experimental-organic-terrain.json) · [素材稽核](../../../docs/evidence/VF2.1.md)
