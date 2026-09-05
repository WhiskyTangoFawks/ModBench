using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

public sealed class CompileRoundTripGateFixture : IDisposable
{
    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-").FullName;
    // Snapshotted after Track and before any Compile: the two Compile facts overwrite ModFolder's
    // plugin binary with non-Track bytes, so mutating facts copy this instead of Tracking again.
    public string TrackedTemplateFolder { get; } =
        Directory.CreateTempSubdirectory("medit-compile-roundtrip-template-").FullName;
    public string GameDirectory { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-game-").FullName;
    public LoadOrderMirror Mirror { get; }
    public PluginKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public CompileRoundTripGateFixture()
    {
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        Mirror = new LoadOrderMirror(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ILoadOrderMirror)Mirror).Reconcile(
            GameDirectory,
            [new LoadOrderEntry(CutDownPluginFixture.PluginFileName, pluginPath, Plugin.Origin!, Slot: 0, Enabled: true, Winning: true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Mirror.LoadOrder!, Plugin.Origin!, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        CopyDirectory(ModFolder, TrackedTemplateFolder);
    }

    public void Dispose()
    {
        Mirror.Dispose();
        TryDelete(ModFolder);
        TryDelete(TrackedTemplateFolder);
        TryDelete(GameDirectory);
    }

    public PluginCompileService CompileService() =>
        new(Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    public string SourceRoot => SourceRootFor(ModFolder);

    public static string SourceRootFor(string modFolder) =>
        Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName));

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
