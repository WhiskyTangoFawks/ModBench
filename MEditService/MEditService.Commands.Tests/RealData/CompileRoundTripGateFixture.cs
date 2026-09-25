using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.RealData;

public sealed class CompileRoundTripGateFixture : IDisposable
{
    public LoadOrderHolder Holder { get; } = new();
    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-").FullName;
    // Snapshotted after Track and before any Compile: the two Compile facts overwrite ModFolder's
    // plugin binary with non-Track bytes, so mutating facts copy this instead of Tracking again.
    public string TrackedTemplateFolder { get; } =
        Directory.CreateTempSubdirectory("medit-compile-roundtrip-template-").FullName;
    public string GameDirectory { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-game-").FullName;
    public PluginCopyKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public CompileRoundTripGateFixture()
    {
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        var loadOrder = new LoadOrderSnapshot(GameDirectory, instanceRoot: null, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Plugin.Origin, Slot: 0, Enabled: true, Winning: true)]));
        Holder.Apply(loadOrder);

        new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(loadOrder, Plugin.Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        CopyDirectory(ModFolder, TrackedTemplateFolder);
    }

    public void Dispose()
    {
        TryDelete(ModFolder);
        TryDelete(TrackedTemplateFolder);
        TryDelete(GameDirectory);
    }

    public PluginCompileService CompileService() =>
        CompileServices.Over(Holder.Current);

    public string SourceRoot => SourceRootFor(ModFolder);

    public static string SourceRootFor(string modFolder) =>
        Path.Combine(modFolder, SourceRepository.RootFor(CutDownPluginFixture.PluginFileName));

    public static Dictionary<string, byte[]> ReadSourceTree(string modFolder) =>
        Directory.EnumerateFiles(SourceRootFor(modFolder), "*.json", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(modFolder, f), File.ReadAllBytes);

    public Dictionary<string, byte[]> ReadSourceTree() => ReadSourceTree(ModFolder);

    // Track's repo is a plain non-bare git init rooted at the mod folder, so it bakes in no absolute
    // paths and a recursive copy including .git yields a complete working repo.
    public static void CopyDirectory(string sourceModFolder, string destinationModFolder)
    {
        foreach (var dir in Directory.EnumerateDirectories(sourceModFolder, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(destinationModFolder, Path.GetRelativePath(sourceModFolder, dir)));

        foreach (var file in Directory.EnumerateFiles(sourceModFolder, "*", SearchOption.AllDirectories))
            File.Copy(file, Path.Combine(destinationModFolder, Path.GetRelativePath(sourceModFolder, file)));
    }

    // A tracked mod folder holds a .git tree whose object files are read-only on some filesystems,
    // and a test failing on cleanup would mask the real assertion that already ran.
    internal static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }
}
