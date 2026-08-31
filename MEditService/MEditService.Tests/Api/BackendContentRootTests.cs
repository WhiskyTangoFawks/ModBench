using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace MEditService.Tests.Api;

/// <summary>
/// The extension spawns the backend without setting a working directory
/// (<c>modbench/src/extension.ts</c>'s <c>cp.spawn</c>), so an unanchored content root would be
/// whatever directory launched the process rather than the directory the binary itself lives in —
/// meaning the committed <c>appsettings.json</c> next to the binary, and the
/// <c>Microsoft.AspNetCore: Warning</c> override in it, would never load. These tests spawn the real,
/// already-built <c>MEditService.Api.dll</c> through the <c>dotnet</c> muxer, as an actual child
/// process launched from an unrelated working directory (the extension itself launches the
/// published native executable directly, but <see cref="AppContext.BaseDirectory"/> — what the
/// fix anchors to — resolves identically either way), rather than going through
/// <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/>, which resolves
/// its own content root by walking up from the test assembly and so never reproduces this bug.
/// </summary>
public sealed class BackendContentRootTests
{
    private static readonly string ApiDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location)!;

    [Fact]
    public async Task SpawnedFromArbitraryCwd_AnchorsContentRootToItsOwnDirectory()
    {
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        // A fixed port (e.g. the committed appsettings.json one) collides with a
        // developer's own running backend — an ephemeral port (127.0.0.1:0; Kestrel refuses dynamic
        // binding on the bare "localhost" host name) can't collide with anything, and the content
        // root — not the port — is what this test witnesses.
        using var process = Spawn(["--urls", "http://127.0.0.1:0"], workingDirectory, lines);
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
        // The extension's argv, at Debug — the harder case: Default=Debug must not resurrect the
        // Microsoft.AspNetCore override, since it's a different config key. An arbitrary free port
        // (not the committed 5172) so a concurrent run or leftover listener can't collide.
        var port = GetFreeTcpPort();
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = Spawn(
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

            // Give the request's log lines a moment to reach the redirected stream.
            await Task.Delay(TimeSpan.FromMilliseconds(500));
            var snapshot = Snapshot(lines);

            // The six-line ASP.NET Core pipeline log that must stay suppressed. Distinct from — and
            // unaffected by — UseSerilogRequestLogging's own one-line-per-request summary (pinned
            // separately below), which writes under a different category entirely.
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
        // No --Serilog:MinimumLevel:Default here: the default (Information) is exactly the
        // "without enabling debug" case.
        var port = GetFreeTcpPort();
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
        var lines = new List<string>();
        using var process = Spawn(["--urls", $"http://localhost:{port}"], workingDirectory, lines);
        try
        {
            var started = await WaitForLineAsync(lines,
                l => l.Contains($"Now listening on: http://localhost:{port}", StringComparison.Ordinal),
                TimeSpan.FromSeconds(15));
            Assert.True(started,
                $"backend never reported listening on its own port; captured output:\n{string.Join('\n', Snapshot(lines))}");

            using var client = new HttpClient();
            await client.GetAsync(new Uri($"http://localhost:{port}/health")); // 200
            await client.GetAsync(new Uri($"http://localhost:{port}/definitely-not-a-route")); // 404, no route matches

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

    private static Process Spawn(IReadOnlyList<string> extraArgs, string workingDirectory, List<string> capturedLines)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(Path.Combine(ApiDirectory, "MEditService.Api.dll"));
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

    private static List<string> Snapshot(List<string> lines)
    {
        lock (lines) return [.. lines];
    }

    private static async Task<bool> WaitForLineAsync(List<string> lines, Func<string, bool> predicate, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (Snapshot(lines).Any(predicate)) return true;
            await Task.Delay(TimeSpan.FromMilliseconds(100));
        }
        return false;
    }

    private static int GetFreeTcpPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
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
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            process.WaitForExit(2000);
        }
        catch (InvalidOperationException)
        {
            // Already exited between the check and the kill — nothing left to do.
        }
        finally
        {
            Directory.Delete(workingDirectory, recursive: true);
        }
    }
}
