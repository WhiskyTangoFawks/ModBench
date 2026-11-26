using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json;
using MEditService.TestSupport;

namespace MEditService.Http.Tests.Api;

public sealed class SpawnedBackendTests(SpawnedBackendTests.Spawned spawned) : IClassFixture<SpawnedBackendTests.Spawned>
{
    private const string EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost = "http://127.0.0.1:0";

    private static readonly string[] AskedToExitWithItsStdin =
        ["--urls", EphemeralIpLoopbackUrlBecauseKestrelRefusesDynamicBindingOnLocalhost, "--ExitWhenStdinCloses", "true"];

    private static readonly string ApiDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location)
        ?? throw new InvalidOperationException($"Expected '{typeof(Program).Assembly.Location}' to have a parent directory.");

    public sealed class Spawned : IAsyncLifetime, IDisposable
    {
        private readonly ScratchDirectory _workingDirectory = new("medit-contentroot-");
        private readonly List<string> _lines = [];
        private Process? _process;

        public int Port { get; } = GetFreeTcpPort();

        public string WorkingDirectory => _workingDirectory;

        public Process Process => _process ?? throw new InvalidOperationException("Expected InitializeAsync to have spawned the backend.");

        public List<string> Lines => Snapshot(_lines);

        public Task<bool> LogsAsync(Func<string, bool> line) => WaitForLineAsync(_lines, line, TimeSpan.FromSeconds(10));

        public async Task InitializeAsync()
        {
            _process = SpawnThroughTheDotnetMuxer(["--urls", $"http://localhost:{Port}"], _workingDirectory, _lines, pipeStdin: true);
            Assert.True(await WaitForLineAsync(_lines, l => l.Contains("Application started", StringComparison.Ordinal), TimeSpan.FromSeconds(15)),
                $"backend never reported starting; captured output:\n{string.Join('\n', Lines)}");
            _process.StandardInput.Close();
        }

        public Task DisposeAsync() => Task.CompletedTask;

        public void Dispose()
        {
            if (_process is not null) KillUnlessAlreadyExitedBetweenTheCheckAndTheKill(_process);
            _process?.Dispose();
            _workingDirectory.Dispose();
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_AnchorsContentRootToItsOwnDirectory_ARealProcessSinceWebApplicationFactoryNeverReproducesTheCwd()
    {
        var expectedContentRoot = Path.TrimEndingDirectorySeparator(ApiDirectory);

        Assert.True(
            await spawned.LogsAsync(l => l.Contains("Content root path: ", StringComparison.Ordinal) &&
                Path.TrimEndingDirectorySeparator(l[(l.IndexOf("Content root path: ", StringComparison.Ordinal) + "Content root path: ".Length)..]) == expectedContentRoot),
            $"expected the content root {expectedContentRoot}; captured output:\n{string.Join('\n', spawned.Lines)}");
    }

    [Fact]
    public void SpawnedWithLogDirectory_WritesItsLogFileThere() =>
        Assert.NotEmpty(Directory.GetFiles(LogDirectory(spawned.WorkingDirectory), "medit-*.log"));

    [Fact]
    public async Task RequestLogging_ShowsFailuresButNeitherSuccessesNorThePipelinesOwnLines()
    {
        using var client = new HttpClient();
        await client.GetAsync(new Uri($"http://localhost:{spawned.Port}/health"));
        await client.GetAsync(new Uri($"http://localhost:{spawned.Port}/definitely-not-a-route"));

        Assert.True(
            await spawned.LogsAsync(l => l.Contains("WRN", StringComparison.Ordinal) && l.Contains("responded 404", StringComparison.Ordinal)),
            $"expected a genuine 4xx to produce a visible line; captured output:\n{string.Join('\n', spawned.Lines)}");
        Assert.DoesNotContain(spawned.Lines, l =>
            l.Contains("responded 200", StringComparison.Ordinal) ||
            l.Contains("Request starting", StringComparison.Ordinal) ||
            l.Contains("Executing endpoint", StringComparison.Ordinal) ||
            l.Contains("Executed endpoint", StringComparison.Ordinal) ||
            l.Contains("Request finished", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ARequestOverKestrelsDefaultBodyLimit_IsReadToTheEnd_ARealProcessSinceTheTestServerSetsNoLimit()
    {
        using var overTheLimit = new StringContent(
            $$"""{"records": [{"text": "{{new string('x', 31_000_000)}}"}]}""", System.Text.Encoding.UTF8, "application/json");
        using var client = new HttpClient();

        using var answered = await client.PostAsync(new Uri($"http://localhost:{spawned.Port}/plugins/make-patch"), overTheLimit);

        var refusal = await answered.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Plugin name and origin are required.", refusal.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task NotAskedToExitWithItsStdin_KeepsRunningOnceItCloses() =>
        Assert.False(await ExitsWithinAsync(spawned.Process, TimeSpan.FromMilliseconds(500)));

    [Fact]
    public async Task AskedToExitWithItsStdin_KeepsRunningWhileItIsOpen_AndExitsOnceItCloses()
    {
        using var workingDirectory = new ScratchDirectory("medit-contentroot-");
        using var process = await StartedWithPipedStdinAsync(AskedToExitWithItsStdin, workingDirectory);
        try
        {
            Assert.False(await ExitsWithinAsync(process, TimeSpan.FromMilliseconds(500)));

            process.StandardInput.Close();

            Assert.True(await ExitsWithinAsync(process, TimeSpan.FromSeconds(15)));
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
