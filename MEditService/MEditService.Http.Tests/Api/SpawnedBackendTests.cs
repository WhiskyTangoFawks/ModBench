using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SpawnedBackendTests
{
    private const string EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost = "http://127.0.0.1:0";

    private static readonly string ApiDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location)
        ?? throw new InvalidOperationException($"Expected '{typeof(Program).Assembly.Location}' to have a parent directory.");

    [Fact]
    public async Task SpawnedFromArbitraryCwd_AnchorsContentRootToItsOwnDirectory_ARealProcessSinceWebApplicationFactoryNeverReproducesTheCwd()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
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
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_WithExtensionArgv_SuppressesRequestPipelineLogsButKeepsAppInfo()
    {
        var port = GetFreeTcpPort();
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
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
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_RequestLogging_ShowsFailuresButNotSuccessesAtDefaultLevel()
    {
        var port = GetFreeTcpPort();
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
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
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public async Task SpawnedWithLogDirectory_WritesItsLogFileThere()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
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
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    private static readonly string[] AskedToExitWithItsStdin =
        ["--urls", EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost, "--ExitWhenStdinCloses", "true"];

    [Fact]
    public async Task AskedToExitWithItsStdin_ExitsOnceItCloses()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
        using var process = await StartedWithPipedStdinAsync(AskedToExitWithItsStdin, workingDirectory);
        try
        {
            process.StandardInput.Close();

            Assert.True(await ExitsWithinAsync(process, TimeSpan.FromSeconds(15)));
        }
        finally
        {
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public async Task AskedToExitWithItsStdin_KeepsRunningWhileItIsOpen()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
        using var process = await StartedWithPipedStdinAsync(AskedToExitWithItsStdin, workingDirectory);
        try
        {
            Assert.False(await ExitsWithinAsync(process, TimeSpan.FromSeconds(3)));
        }
        finally
        {
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public void TheBackendsRuntimeConfig_RunsInvariantGlobalization_SoAMachineWithoutLibicuCanStartIt()
    {
        using var config = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(ApiDirectory, "MEditService.Http.runtimeconfig.json")));

        var properties = config.RootElement.GetProperty("runtimeOptions").GetProperty("configProperties");
        Assert.True(properties.GetProperty("System.Globalization.Invariant").GetBoolean());
    }

    [Fact]
    public async Task AskedToExitWithItsStdin_ExitsWhenItClosesWhileStillStarting()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
        var lines = new List<string>();
        using var process = SpawnThroughTheDotnetMuxer(AskedToExitWithItsStdin, workingDirectory, lines, pipeStdin: true, stallStartup: true);
        try
        {
            var stalled = await WaitForLineAsync(lines, l => l.Contains(StalledStartup.Marker, StringComparison.Ordinal), TimeSpan.FromSeconds(15));
            Assert.True(stalled, $"backend never reached its stalled start; captured output:\n{string.Join('\n', Snapshot(lines))}");

            process.StandardInput.Close();

            Assert.True(await ExitsWithinAsync(process, TimeSpan.FromSeconds(3)),
                $"captured output:\n{string.Join('\n', Snapshot(lines))}");
            Assert.DoesNotContain(Snapshot(lines), l => l.Contains("FTL", StringComparison.Ordinal));
        }
        finally
        {
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    [Fact]
    public async Task NotAsked_KeepsRunningWhenItsStdinCloses()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
        using var process = await StartedWithPipedStdinAsync(
            ["--urls", EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost], workingDirectory);
        try
        {
            process.StandardInput.Close();

            Assert.False(await ExitsWithinAsync(process, TimeSpan.FromSeconds(3)));
        }
        finally
        {
            KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(process);
        }
    }

    private static async Task<Process> StartedWithPipedStdinAsync(IReadOnlyList<string> args, string workingDirectory)
    {
        var lines = new List<string>();
        var process = SpawnThroughTheDotnetMuxer(args, workingDirectory, lines, pipeStdin: true);
        var started = await WaitForLineAsync(lines, l => l.Contains("Application started", StringComparison.Ordinal), TimeSpan.FromSeconds(15));
        Assert.True(started, $"backend never reported starting; captured output:\n{string.Join('\n', Snapshot(lines))}");
        return process;
    }

    private static async Task<bool> ExitsWithinAsync(Process process, TimeSpan timeout)
    {
        using var deadline = new CancellationTokenSource(timeout);
        return await process.WaitForExitAsync(deadline.Token).ContinueWith(t => t.IsCompletedSuccessfully, TaskScheduler.Default);
    }

    private static Process SpawnThroughTheDotnetMuxer(IReadOnlyList<string> extraArgs, string workingDirectory, List<string> capturedLines, bool pipeStdin = false, bool stallStartup = false)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardInput = pipeStdin,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        if (stallStartup)
        {
            psi.Environment["ASPNETCORE_HOSTINGSTARTUPASSEMBLIES"] = typeof(StalledStartup).Assembly.GetName().Name;
            psi.Environment["DOTNET_STARTUP_HOOKS"] = typeof(StalledStartup).Assembly.Location;
        }
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
