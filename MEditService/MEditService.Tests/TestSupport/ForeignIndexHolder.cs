using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// #588: another <i>process</i> holding an index file — what a second Modbench window is. It has
/// to be a process: DuckDB's file lock is per process, and DuckDB.NET shares one database instance
/// per path inside a process, so a second connection from this test host would simply join the
/// first. The holder is <c>python3</c> calling <c>duckdb_open</c> on the test output's own
/// <c>libduckdb</c> through <c>ctypes</c> — the same library, no extra project — kept open until
/// disposed. Tests that need it carry <see cref="ForeignIndexHolderFactAttribute"/>.
/// </summary>
public sealed class ForeignIndexHolder : IDisposable
{
    private const string Script = """
        import ctypes, sys
        lib = ctypes.CDLL(sys.argv[1])
        lib.duckdb_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        db = ctypes.c_void_p()
        rc = lib.duckdb_open(sys.argv[2].encode(), ctypes.byref(db))
        print('held' if rc == 0 else 'failed', flush=True)
        sys.stdin.readline()
        """;

    private readonly Process _process;
    private bool _disposed;

    public static bool Available => Python() != null;

    private ForeignIndexHolder(Process process) => _process = process;

    /// <summary>Opens <paramref name="indexPath"/> in a second process and returns once it is held.
    /// Throws if the other process could not take it — a test that asked for a held file must not
    /// silently run against an unheld one.</summary>
    public static ForeignIndexHolder Hold(string indexPath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(indexPath)!);
        var psi = new ProcessStartInfo(Python()!)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(Script);
        psi.ArgumentList.Add(NativeLibrary());
        psi.ArgumentList.Add(indexPath);
        var process = Process.Start(psi)!;
        // Bounded: a python that neither answers nor exits (a wedged native load) must fail the test
        // with a diagnosis, not hang the suite.
        var answer = Task.Run(process.StandardOutput.ReadLine);
        var line = answer.Wait(TimeSpan.FromSeconds(30)) ? answer.Result : null;
        if (line != "held")
        {
            process.Kill();
            var stderr = process.StandardError.ReadToEnd();
            throw new InvalidOperationException($"The foreign holder could not open {indexPath}: {line ?? "(no answer within 30 s)"} {stderr}");
        }
        return new ForeignIndexHolder(process);
    }

    /// <summary>Kills the holder; the OS releases DuckDB's lock with the process. Idempotent, so a
    /// test can close the other window mid-story and still leave the <c>using</c> in place.</summary>
    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (!_process.HasExited) _process.Kill();
        _process.WaitForExit(10_000);
        _process.Dispose();
    }

    private static string? Python() =>
        (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator)
            .Select(dir => Path.Combine(dir, RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "python.exe" : "python3"))
            .FirstOrDefault(File.Exists);

    private static string NativeLibrary()
    {
        var (os, file) = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? ("win", "duckdb.dll")
            : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? ("osx", "libduckdb.dylib") : ("linux", "libduckdb.so");
        // The package ships portable RIDs (linux-x64), while RuntimeIdentifier here is the
        // distro-specific one (ubuntu.24.04-x64) — so match by OS family and architecture.
        var arch = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant();
        var portable = Path.Combine(AppContext.BaseDirectory, "runtimes", $"{os}-{arch}", "native", file);
        var candidates = new[] { Path.Combine(AppContext.BaseDirectory, file), portable };
        return candidates.FirstOrDefault(File.Exists)
            ?? throw new FileNotFoundException($"No {file} beside the test assembly or at {portable}.");
    }
}

/// <summary>A fact that needs <see cref="ForeignIndexHolder"/>: skipped where no python3 is on PATH.</summary>
public sealed class ForeignIndexHolderFactAttribute : FactAttribute
{
    public ForeignIndexHolderFactAttribute()
    {
        if (!ForeignIndexHolder.Available) Skip = "python3 not on PATH: cannot hold the index from a second process.";
    }
}
