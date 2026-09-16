using System.Diagnostics;
using System.Runtime.InteropServices;
using MEditService.LoadOrder;

namespace MEditService.Tests.TestSupport;

/// <summary>Another process holding an index file. It has to be a process: DuckDB's lock is per
/// process and DuckDB.NET shares one instance per path, so a connection would join.</summary>
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

    public static ForeignIndexHolder Hold(string indexPath)
    {
        Directory.CreateDirectory(PathShape.DirectoryOf(indexPath));
        var python = Python() ?? throw new InvalidOperationException("Expected python3 on PATH (callers gate on Available).");
        var psi = new ProcessStartInfo(python)
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
        var process = Process.Start(psi) ?? throw new InvalidOperationException("Expected python3 to start a new process.");
        // Bounded: a python that neither answers nor exits (a wedged native load) must fail the test
        // with a diagnosis, not hang the suite.
        var answer = Task.Run(process.StandardOutput.ReadLine);
        var line = answer.Wait(TimeSpan.FromSeconds(30)) ? answer.GetAwaiter().GetResult() : null;
        if (line != "held")
        {
            process.Kill();
            var stderr = process.StandardError.ReadToEnd();
            throw new InvalidOperationException($"The foreign holder could not open {indexPath}: {line ?? "(no answer within 30 s)"} {stderr}");
        }
        return new ForeignIndexHolder(process);
    }

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
