# PrimerDesign

PrimerDesign 是一套本地网页工具，用来批量设计和检查 PCR 引物。它在 Windows 上启动一个只监听 `127.0.0.1` 的服务，输入 multi-FASTA 后，把设计和基因组验证交给配置好的服务器执行。

当前版本：`0.5.4`。软件按 Primer3 设计、UCSC `isPcr` 验证、必要时后台单引物 BLAT 诊断的顺序运行。BLAT 只用于后台排查，最终报告不显示 BLAT 明细。

## 启动

日常使用便携版：

```text
dist\PrimerDesign-portable-win-x64\PrimerDesign.exe
```

双击后，服务在后台启动，浏览器会打开本地页面，不会出现命令行窗口。再次双击只会打开已有实例。

需要查看启动日志或调试时，可以运行：

```powershell
npm run app
```

默认地址是 `http://127.0.0.1:43110`。网页中的“退出软件”只会关闭空闲服务。批次运行时，页面会先保护当前任务。

## 网页操作

1. 上传或粘贴 1 至 20 条记录的 multi-FASTA。
2. 选择本批唯一的基因组：`hs1`、`hg38` 或 `mm10`。
3. 点“解析并预览”，检查每条序列的名称和长度。
4. 修改 Primer3 参数。数值框支持键盘输入、粘贴和全选。
5. 点“开始设计”，等待页面显示 Primer3、isPcr、结果下载和报告生成的进度。
6. 打开报告后，可以筛选、排序、复制到 Excel，或下载 CSV 和原始 FASTA。

FASTA 标题的第一个非空字段是内部 `sequence_id`，完整标题是显示名称。软件会在提交前检查重复 ID、空序列、非法碱基、过短序列和记录数上限。网页批次只接受一种 assembly，不能在同一批中混用 `hs1`、`hg38` 和 `mm10`。

## Primer3 和验证参数

每条 FASTA 默认返回 5 对候选引物，允许设置为 1 至 20 对。默认值如下：

- Tm 目标 `60°C`，容差 `±5°C`
- 引物长度最小、最适、最大值为 `18/23/28 bp`
- 设计产物长度 `80-1000 bp`
- GC 范围 `40-60%`
- 基因组 isPCR 最大产物长度 `10000 bp`
- isPCR 默认 4 路并行，可设置为 4 至 8 路

网页和服务端都会检查数值范围及字段关系。提交后，实际参数会写入批次的 `config.json`。断点重试继续使用这份快照，不会被后来修改的默认值替换。

服务器作业申请 `16 CPU / 64 GB RAM`。isPCR 会按候选分片并行运行，页面显示已完成的候选数量。BLAT 只对无产物、多产物或其他可疑候选作补充诊断。

## 输出文件

每个批次保存在 `batches\<batch-id>` 目录。常用文件如下：

- `input.fasta`：实际用于设计的标准化输入，可从报告下载
- `config.json`：本批参数和服务器设置快照
- `primer3-results.json`：Primer3 原始解析结果
- `candidates.json`：标准化候选引物
- `ucsc-results.json`：isPcr 及后台诊断的完整记录
- `report.html`：可离线打开的报告
- `summary.csv`：带 UTF-8 BOM 的 CSV，适合用 Excel 打开

报告表格固定使用下面的列顺序：

```text
sequence_id\tdisplay_name\tcandidate_id\trank\tforward_primer\treverse_primer\tF_start_end\tR_start_end\tgenomic_pcr_length\tdesign_length\tproduct_count\tvalidation_classification\tinput_length\tgenomic_product_locations\tassembly\tforward_tm\treverse_tm\tforward_gc\treverse_gc\tscore\tgenomic_product_classes\tvalidation_products\twarnings
```

`F_start_end` 和 `R_start_end` 是引物在输入 FASTA 模板中的 1-based 闭区间，格式为“起点-终点”。反向引物仍按 5' 到 3' 显示，坐标按输入序列方向记录。

`design_length` 是 Primer3 模板产物长度，`genomic_pcr_length` 是基因组验证产物长度，二者可能不同。`product_count` 保留真实产物总数。多位点候选在报告中只展开前 5 个位置、长度和类别，完整结果仍保存在批次原始验证文件中。

报告中的“删除”会把整个批次目录移入 Windows 回收站，不会永久删除。运行中的批次不能删除。

## 命令行

```powershell
node .\src\cli.mjs help
node .\src\cli.mjs batch-prepare --fasta A:\input.fa --manifest A:\batch.tsv --name example
node .\src\cli.mjs batch-run --batch A:\CodexProject\prime_design\batches\<batch-id>
node .\src\cli.mjs batch-revalidate --batch A:\CodexProject\prime_design\batches\<batch-id> --max-product-size 10000 --parallelism 4
node .\src\cli.mjs batch-report --batch A:\CodexProject\prime_design\batches\<batch-id>
```

网页会自动生成 manifest。只有命令行准备批次时才需要三列 TSV：`sequence_id`、`fasta_record`、`assembly`。

## 服务器要求

Windows 端通过 OpenSSH 连接服务器，并通过 Slurm 提交任务。服务器需要安装或准备：

- Primer3 `primer3_core`
- UCSC `isPcr` 和 `blat`
- `hs1`、`hg38`、`mm10` 对应的基因组索引
- 项目中的 `scripts/server/*.slurm` 作业脚本

系统检查页面会检查 A 盘数据目录、Windows SSH/SCP、SSH 配置、Slurm 资源请求以及服务器端工具和索引。服务器暂时离线时，软件仍可打开；提交批次会显示可重试错误。

## 开发和构建

```powershell
npm test
npm run build:portable
```

便携构建使用项目内固定版本的 Node.js 和 A 盘便携 .NET 8 SDK。构建结果位于：

```text
dist\PrimerDesign-portable-win-x64\
dist\PrimerDesign-portable-win-x64.zip
dist\PrimerDesign-portable-win-x64.zip.sha256
```

发行包包含启动器、Node.js 运行时、网页、服务端代码、默认配置和生产 Slurm 脚本。SSH 私钥、密码、历史批次、测试文件和大型基因组索引不会打进发行包。

## 安全边界

- HTTP 服务只监听 `127.0.0.1`。
- 写操作要求会话令牌，并检查请求来源。
- 浏览器不能提交任意本地路径。
- 批次和日志只写入配置的数据目录。
- 删除操作只使用 Windows 回收站。
- 批量验证使用服务器本地工具，不自动操作 UCSC 公共网页。

更完整的中文操作说明见 [docs/PrimerDesign_中文使用说明.md](docs/PrimerDesign_中文使用说明.md)。
