# PrimerDesign

PrimerDesign 是一个仅在本机 `127.0.0.1` 上运行的批量引物设计网页软件。用户提交 1–20 条 multi-FASTA，选择一个基因组并设置参数后，软件会自动完成：

1. 服务器 Primer3 引物设计。
2. 本地 UCSC `isPcr` 基因组产物验证。
3. 对无产物、多产物或可疑候选执行后台单引物 BLAT 诊断。
4. 生成可筛选、可复制到 Excel 的 HTML 报告和 UTF-8 CSV。

软件版本：`0.4.0`。仅供当前用户非商业使用。

## 快速开始

日常使用便携版：

```text
dist\PrimerDesign-portable-win-x64\PrimerDesign.exe
```

双击后服务会在后台启动并打开浏览器，不显示命令行窗口。重复双击会打开已经运行的实例，不会启动第二个服务。

开发或故障诊断模式：

```powershell
npm run app
```

默认地址为 `http://127.0.0.1:43110`。网页中的“退出软件”会安全关闭空闲服务；有任务运行时可选择任务完成后退出。

## 网页操作

1. 上传或粘贴包含 1–20 条记录的 multi-FASTA。
2. 选择本批统一使用的 `hs1`、`hg38` 或 `mm10`。
3. 调整 Primer3 参数。全部数值框都支持键盘输入、粘贴和全选。
4. 点击“解析并预览”，检查序列名称和长度。
5. 点击“开始设计”，等待 Primer3、isPCR 和必要的后台诊断完成。
6. 打开最终报告，按序列、assembly、排名和验证结论筛选；使用复制按钮直接粘贴到 Excel。

默认参数：

- 每条 FASTA 最多返回 5 对候选，可设置 1–20 对。
- Tm：目标 `60°C`，容差 `±5°C`。
- 引物长度：最小/最适/最大 `18/23/28 bp`。
- 模板设计产物：`80–1000 bp`。
- GC：`40–60%`。
- 基因组 isPCR 最大产物：`10000 bp`，网页允许 `1000–50000 bp`。

每批实际参数都会冻结在批次 `config.json` 中。断点重试继续使用原参数，不会被后来修改的默认值覆盖。

## 输入与结果

FASTA 标题的第一个非空字段作为内部 ID，完整标题作为显示名称。软件拒绝重复 ID、空序列、非法碱基、过短序列和超过 20 条记录的输入。

批次保存在 `batches\<batch-id>`，主要文件包括：

- `input.fasta`：标准化输入。
- `config.json`：冻结参数与服务器配置快照。
- `primer3-results.json`：Primer3 原始解析结果。
- `candidates.json`：标准化候选引物。
- `ucsc-results.json`：isPCR 与后台诊断的完整审计结果。
- `summary.csv`：带 UTF-8 BOM 的 Excel 友好表格。
- `report.html`：可离线打开的自包含报告。

最终表格显示正反向引物、输入模板 1-based 闭区间、Tm、GC、Primer3 penalty、模板设计产物长度、基因组验证产物长度、基因组位置、产物数量和验证结论。后台 BLAT 明细保留在原始审计数据中，不在最终表格或公共结果接口显示。

历史批次的“删除”会将整个批次目录移入 Windows 回收站，不会永久删除；运行中的批次不能删除。

## 命令行

```powershell
node .\src\cli.mjs help
node .\src\cli.mjs batch-prepare --fasta A:\input.fa --manifest A:\batch.tsv --name example
node .\src\cli.mjs batch-run --batch A:\CodexProject\prime_design\batches\<batch-id>
node .\src\cli.mjs batch-revalidate --batch A:\CodexProject\prime_design\batches\<batch-id> --max-product-size 10000
node .\src\cli.mjs batch-report --batch A:\CodexProject\prime_design\batches\<batch-id>
```

网页会自动生成 manifest；只有命令行批量准备时才需要三列 TSV：`sequence_id`、`fasta_record`、`assembly`。

## 服务器与工具

计算通过 Windows OpenSSH 连接配置中的服务器，并通过 Slurm 申请 `16 CPU / 64 GB RAM`。服务器端需要：

- Primer3 `primer3_core`。
- UCSC `isPcr`、`blat` 及 `hs1`、`hg38`、`mm10` 数据库。
- 项目提供的 `scripts/server/*.slurm` 作业脚本。

系统检查页面会验证 A 盘可写空间、Windows SSH/SCP、SSH 配置、Slurm 请求和服务器工具状态。服务器离线不影响软件打开，但提交任务会显示可重试错误。

## 开发与构建

```powershell
npm test
npm run build:portable
```

便携构建固定使用 `vendor\node\node-v24.18.0-win-x64.zip` 和 A 盘便携 .NET 8 SDK。输出位于：

```text
dist\PrimerDesign-portable-win-x64\
dist\PrimerDesign-portable-win-x64.zip
dist\PrimerDesign-portable-win-x64.zip.sha256
```

发行包只包含启动器、固定 Node 运行时、网页、运行代码、默认配置和生产 Slurm 脚本，不包含 SSH 密钥、密码、历史批次、开发测试或大型基因组。

## 安全边界

- HTTP 服务只监听 `127.0.0.1`。
- 写操作要求会话令牌和同源校验。
- 浏览器不能提交任意本地路径。
- 所有批次和日志只写入配置的数据根目录。
- 删除操作只使用 Windows 回收站。
- UCSC 公共网页不用于批量自动化；正式验证使用服务器本地工具。

更完整的中文说明见 [docs/PrimerDesign_中文使用说明.md](docs/PrimerDesign_中文使用说明.md)。
