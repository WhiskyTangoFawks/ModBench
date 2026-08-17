using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace MEditService.Tests.Api;

/// <summary>
/// #343: the extension spawns the backend without setting a working directory
/// (<c>modbench/src/extension.ts</c>'s <c>cp.spawn</c>), so the process's content root used to be
/// whatever directory launched it rather than the directory the binary itself lives in — meaning
/// the committed <c>appsettings.json</c> next to the binary, and the
/// <c>Microsoft.AspNetCore: Warning</c> override in it, never loaded. These tests spawn the real,
/// already-built <c>MEditService.Api.dll</c> as an actual child process from an unrelated working
/// directory — the same shape the extension spawns — rather than going through
/// <see cref="Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactory{TEntryPoint}"/>, which resolves
/// its own content root by walking up from the test assembly and so never reproduces this bug.
/// </summary>
public sealed class BackendContentRootTests
{
    private static readonly string ApiDirectory = Path.GetDirectoryName(typeof(Program).Assembly.Location)!;

    [Fact]
    public async Task SpawnedFromArbitraryCwd_WithoutUrlsFlag_BindsToAppsettingsConfiguredPort()
    {
        var appsettingsPath = Path.Combine(ApiDirectory, "appsettings.json");
        Assert.True(File.Exists(appsettingsPath),
            $"expected appsettings.json next to the spawned dll at {ApiDirectory} — same layout the extension bundles");
        var configuredUrls = JsonDocument.Parse(await File.ReadAllTextAsync(appsettingsPath))
            .RootElement.GetProperty("Urls").GetString()!;
        var configuredPort = new Uri(configuredUrls).Port;

        var lines = new List<string>();
        using var process = Spawn([], lines);
        try
        {
            // Identity, not reachability (#343 review): a stray listener already on this port would
            // make a bare TCP/HTTP probe a false green on unfixed code, exactly what
            // WebApplicationFactory was rejected for above. The child's own stdout naming the address
            // it bound is the only signal that can't be satisfied by someone else's process.
            var boundOwnPort = await WaitForLineAsync(lines,
                l => l.Contains($"Now listening on: http://localhost:{configuredPort}", StringComparison.Ordinal),
                TimeSpan.FromSeconds(15));

            Assert.True(boundOwnPort,
                $"expected the spawned backend to bind the port from its own appsettings.json " +
                $"({configuredPort}); captured output:\n{string.Join('\n', Snapshot(lines))}");
        }
        finally
        {
            Kill(process);
        }
    }

    [Fact]
    public async Task SpawnedFromArbitraryCwd_WithExtensionArgv_SuppressesRequestPipelineLogsButKeepsAppInfo()
    {
        // #205's argv, at Debug — the harder case: Default=Debug must not resurrect the
        // Microsoft.AspNetCore override, since it's a different config key. An arbitrary free port
        // (not the committed 5172) so a concurrent run or leftover listener can't collide.
        var port = GetFreeTcpPort();
        var lines = new List<string>();
        using var process = Spawn(
            ["--urls", $"http://localhost:{port}", "--Serilog:MinimumLevel:Default", "Debug"], lines);
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

            Assert.DoesNotContain(snapshot, l =>
                l.Contains("Request starting", StringComparison.Ordinal) ||
                l.Contains("Executing endpoint", StringComparison.Ordinal) ||
                l.Contains("Executed endpoint", StringComparison.Ordinal) ||
                l.Contains("Request finished", StringComparison.Ordinal));
            Assert.Contains(snapshot, l => l.Contains("Application started", StringComparison.Ordinal));
        }
        finally
        {
            Kill(process);
        }
    }

    private static Process Spawn(IReadOnlyList<string> extraArgs, List<string> capturedLines)
    {
        var workingDirectory = Directory.CreateTempSubdirectory("medit-contentroot-").FullName;
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

    private static void Kill(Process process)
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
    }
}
