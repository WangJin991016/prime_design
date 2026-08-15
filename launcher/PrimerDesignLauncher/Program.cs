using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Windows.Forms;

namespace PrimerDesignLauncher;

internal sealed record LauncherSettings(string DataRoot, int Port = 43110);

internal static class Program
{
    private const string ServiceId = "prime-design-local-v1";
    private const string MutexName = "Local\\PrimerDesignPortable-43110";
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(2) };

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            Run(args);
        }
        catch (Exception error)
        {
            ShowError(error.Message);
        }

        // WinForms/HTTP runtime threads can outlive the supervised Node process.
        // All owned resources have been released when Run returns, so terminate
        // the GUI supervisor explicitly instead of leaving a hidden process behind.
        Environment.Exit(0);
    }

    private static void Run(string[] args)
    {
        var openBrowser = !args.Contains("--no-open", StringComparer.OrdinalIgnoreCase);
        var baseDir = AppContext.BaseDirectory;
        var settings = LoadSettings(baseDir).GetAwaiter().GetResult();
        var url = $"http://127.0.0.1:{settings.Port}";
        if (IsHealthy(url).GetAwaiter().GetResult())
        {
            if (openBrowser) OpenBrowser(url);
            return;
        }

        using var mutex = new Mutex(false, MutexName);
        if (!mutex.WaitOne(TimeSpan.FromSeconds(8)))
        {
            if (WaitForHealth(url, TimeSpan.FromSeconds(8)).GetAwaiter().GetResult() && openBrowser) OpenBrowser(url);
            else ShowError("另一个启动过程正在运行，但本地服务尚未就绪。请稍后重试。");
            return;
        }

        try
        {
            if (IsHealthy(url).GetAwaiter().GetResult())
            {
                if (openBrowser) OpenBrowser(url);
                return;
            }

            var nodePath = Path.Combine(baseDir, "runtime", "node", "node.exe");
            var appRoot = Path.Combine(baseDir, "app");
            var entry = Path.Combine(appRoot, "src", "app.mjs");
            RequireFile(nodePath, "便携 Node.js");
            RequireFile(entry, "应用入口");
            Directory.CreateDirectory(settings.DataRoot);
            EnsureADrive(settings.DataRoot);
            var logDir = Path.Combine(settings.DataRoot, "logs");
            Directory.CreateDirectory(logDir);
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var outPath = Path.Combine(logDir, $"portable-{stamp}.out.log");
            var errPath = Path.Combine(logDir, $"portable-{stamp}.err.log");

            using var child = StartNode(nodePath, entry, appRoot, settings);
            var stdoutTask = child.StandardOutput.ReadToEndAsync();
            var stderrTask = child.StandardError.ReadToEndAsync();

            if (!WaitForHealth(url, TimeSpan.FromSeconds(15)).GetAwaiter().GetResult())
            {
                if (!child.HasExited) child.Kill(entireProcessTree: true);
                child.WaitForExit();
                PersistLogs(outPath, errPath, stdoutTask, stderrTask);
                ShowError($"本地服务未能在 15 秒内启动。端口可能被其他程序占用。\n\n输出日志：{outPath}\n错误日志：{errPath}");
                return;
            }
            if (openBrowser) OpenBrowser(url);
            child.WaitForExit();
            PersistLogs(outPath, errPath, stdoutTask, stderrTask);
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static async Task<LauncherSettings> LoadSettings(string baseDir)
    {
        var file = Path.Combine(baseDir, "settings.json");
        RequireFile(file, "便携版设置");
        var value = JsonSerializer.Deserialize<LauncherSettings>(await File.ReadAllTextAsync(file), new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? throw new InvalidOperationException("settings.json 无法解析。");
        if (value.Port != 43110) throw new InvalidOperationException("便携版端口必须固定为 43110。");
        EnsureADrive(value.DataRoot);
        return value with { DataRoot = Path.GetFullPath(value.DataRoot) };
    }

    private static Process StartNode(string nodePath, string entry, string appRoot, LauncherSettings settings)
    {
        var start = new ProcessStartInfo(nodePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = appRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(entry);
        start.Environment["PRIME_DESIGN_APP_ROOT"] = appRoot;
        start.Environment["PRIME_DESIGN_DATA_ROOT"] = settings.DataRoot;
        start.Environment["PRIME_DESIGN_PORT"] = settings.Port.ToString();
        return Process.Start(start) ?? throw new InvalidOperationException("无法启动便携 Node.js 进程。");
    }

    private static void PersistLogs(string outPath, string errPath, Task<string> stdoutTask, Task<string> stderrTask)
    {
        File.WriteAllText(outPath, stdoutTask.GetAwaiter().GetResult());
        File.WriteAllText(errPath, stderrTask.GetAwaiter().GetResult());
    }

    private static async Task<bool> IsHealthy(string url)
    {
        try
        {
            using var response = await Client.GetAsync($"{url}/api/health");
            if (!response.IsSuccessStatusCode) return false;
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            return json.RootElement.TryGetProperty("serviceId", out var id) && id.GetString() == ServiceId;
        }
        catch { return false; }
    }

    private static async Task<bool> WaitForHealth(string url, TimeSpan timeout)
    {
        var stop = Stopwatch.StartNew();
        while (stop.Elapsed < timeout)
        {
            if (await IsHealthy(url)) return true;
            await Task.Delay(500);
        }
        return false;
    }

    private static void OpenBrowser(string url) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });

    private static void RequireFile(string path, string label)
    {
        if (!File.Exists(path)) throw new FileNotFoundException($"{label}缺失：{path}", path);
    }

    private static void EnsureADrive(string path)
    {
        if (!string.Equals(Path.GetPathRoot(Path.GetFullPath(path)), "A:\\", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"数据目录必须位于 A 盘：{path}");
    }

    private static void ShowError(string message) => MessageBox.Show(message, "Primer Design 启动错误", MessageBoxButtons.OK, MessageBoxIcon.Error);
}
