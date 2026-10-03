using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace MEditService.Http.Tests.Api;

public sealed class BackendContentRootTests
{
    private const string EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost = "http://127.0.0.1:0";

    private static readonly string ApiDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location)
        ?? throw new InvalidOperationException($"Expected '{typeof(Program).Assembly.Location}' to have a parent directory.");

    [Fact]
    public async Task SpawnedFromArbitraryCwd_AnchorsContentRootToItsOwnDirectory_ARealProcessSinceWebApplicationFactoryNeverReproducesTheCwd()
    {
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = SpawnThroughTheDotnetMuxer(["--urls", EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost], workingDirectory, lines);
        try
        {
            var expectedContentRoot = Path.TrimEndingDirectorySeparator(ApiDirectory);
            var reportedOwnDirectory = await WaitForLineAsync(lines,
                l => l.Contains("Content root path: ", StringComparison.Ordinal) &&
                     Path.TrimEndingDirectorySeparator(
                         l[(l.IndexOf("Content root path: ", StringComparison.Ordinal) + "Content root path: ".Length)..])
                         == expectedContentRoot,
                TimeSpan.FromSeconds(15));

            Assert.True(reportedOwnDirectory,
                $"expected the spawned backend to report its content root as {expectedContentRoot} " +
                $"(its own directory), not {workingDirectory} (the cwd it was launched from); " +
                $"captured output:\n{string.Join('\n', Snapshot(lines))}");
        }
        finally
        {
            Cleanup(process, workingDirectory);
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_WithExtensionArgv_SuppressesRequestPipelineLogsButKeepsAppInfo()
    {
        var port = GetFreeTcpPort();
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = SpawnThroughTheDotnetMuxer(
            ["--urls", $"http://localhost:{port}", "--Serilog:MinimumLevel:Default", "Debug"],
            workingDirectory, lines);
        try
        {
            var started = await WaitForLineAsync(lines,
                l => l.Contains($"Now listening on: http://localhost:{port}", StringComparison.Ordinal),
                TimeSpan.FromSeconds(15));
            Assert.True(started,
                $"backend never reported listening on its own port; captured output:\n{string.Join('\n', Snapshot(lines))}");

            using var client = new HttpClient();
            for (var i = 0; i < 3; i++)
                await client.GetAsync(new Uri($"http://localhost:{port}/health"));

            await client.GetAsync(new Uri($"http://localhost:{port}/definitely-not-a-route"));
            var sawTheOrderingMarker404 = await WaitForLineAsync(lines,
                l => l.Contains("WRN", StringComparison.Ordinal) && l.Contains("responded 404", StringComparison.Ordinal),
                TimeSpan.FromSeconds(10));
            Assert.True(sawTheOrderingMarker404,
                $"expected the marker 404 to produce a visible line; captured output:\n{string.Join('\n', Snapshot(lines))}");
            var snapshot = Snapshot(lines);

            Assert.DoesNotContain(snapshot, l =>
                l.Contains("Request starting", StringComparison.Ordinal) ||
                l.Contains("Executing endpoint", StringComparison.Ordinal) ||
                l.Contains("Executed endpoint", StringComparison.Ordinal) ||
                l.Contains("Request finished", StringComparison.Ordinal));
            Assert.Contains(snapshot, l => l.Contains("Application started", StringComparison.Ordinal));
        }
        finally
        {
            Cleanup(process, workingDirectory);
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_RequestLogging_ShowsFailuresButNotSuccessesAtDefaultLevel()
    {
        var port = GetFreeTcpPort();
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = SpawnThroughTheDotnetMuxer(["--urls", $"http://localhost:{port}"], workingDirectory, lines);
        try
        {
            var started = await WaitForLineAsync(lines,
                l => l.Contains($"Now listening on: http://localhost:{port}", StringComparison.Ordinal),
                TimeSpan.FromSeconds(15));
            Assert.True(started,
                $"backend never reported listening on its own port; captured output:\n{string.Join('\n', Snapshot(lines))}");

            using var client = new HttpClient();
            await client.GetAsync(new Uri($"http://localhost:{port}/health"));
            await client.GetAsync(new Uri($"http://localhost:{port}/definitely-not-a-route"));

            var sawFailureLine = await WaitForLineAsync(lines,
                l => l.Contains("WRN", StringComparison.Ordinal) && l.Contains("responded 404", StringComparison.Ordinal),
                TimeSpan.FromSeconds(10));
            var snapshot = Snapshot(lines);

            Assert.True(sawFailureLine,
                $"expected a genuine 4xx to produce a visible line without enabling debug; " +
                $"captured output:\n{string.Join('\n', snapshot)}");
            Assert.DoesNotContain(snapshot, l => l.Contains("responded 200", StringComparison.Ordinal));
        }
        finally
        {
            Cleanup(process, workingDirectory);
        }
    }

    [Fact]
    public async Task SpawnedWithLogDirectory_WritesItsLogFileThere()
    {
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = SpawnThroughTheDotnetMuxer(["--urls", EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost], workingDirectory, lines);
        try
        {
            var started = await WaitForLineAsync(lines,
                l => l.Contains("Application started", StringComparison.Ordinal),
                TimeSpan.FromSeconds(15));
            Assert.True(started,
                $"backend never reported starting; captured output:\n{string.Join('\n', Snapshot(lines))}");

            Assert.NotEmpty(Directory.GetFiles(LogDirectory(workingDirectory), "medit-*.log"));
        }
        finally
        {
            Cleanup(process, workingDirectory);
        }
    }

    private static Process SpawnThroughTheDotnetMuxer(IReadOnlyList<string> extraArgs, string workingDirectory, List<string> capturedLines)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(Path.Combine(ApiDirectory, "MEditService.Http.dll"));
        psi.ArgumentList.Add("--LogDirectory");
        psi.ArgumentList.Add(LogDirectory(workingDirectory));
        foreach (var arg in extraArgs) psi.ArgumentList.Add(arg);

        var process = new Process { StartInfo = psi };
        process.OutputDataReceived += (_, e) => Capture(capturedLines, e.Data);
        process.ErrorDataReceived += (_, e) => Capture(capturedLines, e.Data);
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static void Capture(List<string> capturedLines, string? line)
    {
        if (line is null) return;
        lock (capturedLines) capturedLines.Add(line);
    }

    private static string LogDirectory(string workingDirectory) => Path.Combine(workingDirectory, "logs");

    private static List<string> Snapshot(List<string> lines)
    {
        lock (lines) return [.. lines];
    }

    private static async Task<bool> WaitForLineAsync(List<string> lines, Func<string, bool> predicate, TimeSpan timeout)
    {
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < timeout)
        {
            if (Snapshot(lines).Any(predicate)) return true;
            await Task.Delay(TimeSpan.FromMilliseconds(100));
        }
        return false;
    }

    private static int GetFreeTcpPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static void Cleanup(Process process, string workingDirectory)
    {
        try
        {
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
        finally
        {
            Directory.Delete(workingDirectory, recursive: true);
        }
    }

    private static void KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            process.WaitForExit();
        }
        catch (InvalidOperationException)
        {
            return;
        }
    }
}
