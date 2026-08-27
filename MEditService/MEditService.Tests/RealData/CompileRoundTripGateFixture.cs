using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.RealData;

/// <summary>
/// #512: the once-per-class half of <see cref="CompileRoundTripGateTests"/>' setup. xUnit
/// constructs exactly one of these per test class run (via <c>IClassFixture&lt;T&gt;</c>), so the
/// ~36s <see cref="TrackService.TrackAsync"/> call — copy the #369 fixture plugin, load a session,
/// Track it — runs once instead of once per <c>[Fact]</c>. That repeated Track (present since #416)
/// was 6 of the backend suite's 9 minutes on its own.
///
/// <para><b>Two folders, not one.</b> <see cref="ModFolder"/> is the "live" tree the 8 read-only
/// facts in <see cref="CompileRoundTripGateTests"/> share: they only read it, except the three
/// <c>Compile_OfTheRealFixture_*</c> tests, which also compile into it and so overwrite its plugin
/// binary with deterministic-but-not-Track's-own-bytes output. <see cref="TrackedTemplateFolder"/> is
/// a second copy, taken immediately after Track succeeds and before any Compile can run against
/// <see cref="ModFolder"/>, and is never touched again afterward. The 2 mutating facts
/// (<c>RecordEditService.EditField</c> writes its record's source file back to disk, so they cannot
/// share a live tree with anything else) each <c>cp -r</c> this pristine snapshot into their own
/// scratch copy instead of paying for a second Track — copying ~2,600 small files plus a tiny local
/// <c>.git</c> is seconds, not the ~36s Track itself costs.</para>
/// </summary>
public sealed class CompileRoundTripGateFixture : IDisposable
{
    public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-").FullName;
    public string TrackedTemplateFolder { get; } =
        Directory.CreateTempSubdirectory("medit-compile-roundtrip-template-").FullName;
    public string GameDirectory { get; } = Directory.CreateTempSubdirectory("medit-compile-roundtrip-game-").FullName;
    public SessionManager Sessions { get; }
    public PluginKey Plugin { get; } = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public CompileRoundTripGateFixture()
    {
        var pluginPath = Path.Combine(ModFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        Sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)Sessions).LoadExplicit(
            GameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, Plugin.Origin!, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(Sessions.Session!, Plugin.Origin!, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        CopyDirectory(ModFolder, TrackedTemplateFolder);
    }

    public void Dispose()
    {
        Sessions.Dispose();
        TryDelete(ModFolder);
        TryDelete(TrackedTemplateFolder);
        TryDelete(GameDirectory);
    }

    public PluginCompileService CompileService() =>
        new(Sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    public string SourceRoot => SourceRootFor(ModFolder);

    public static string SourceRootFor(string modFolder) =>
        Path.Combine(modFolder, SourceRecordPath.RootFor(CutDownPluginFixture.PluginFileName));

    /// <summary>The tree Track wrote under <paramref name="modFolder"/>, keyed exactly the way
    /// <c>DeriveSourceTreeFromBinary</c> keys its own, so the two dictionaries are directly
    /// comparable.</summary>
    public static Dictionary<string, byte[]> ReadSourceTree(string modFolder) =>
        Directory.EnumerateFiles(SourceRootFor(modFolder), "*.json", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(modFolder, f), File.ReadAllBytes);

    public Dictionary<string, byte[]> ReadSourceTree() => ReadSourceTree(ModFolder);

    /// <summary>A full, recursive copy, <c>.git</c> included — <see cref="SourceRepository.Track"/>'s
    /// repo is a plain, non-bare <c>git init</c> rooted at <paramref name="sourceModFolder"/> itself
    /// (ADR-0041; a fresh local repo has no absolute-path state baked into it), so copying the
    /// directory copies a complete, working repo, not just the files it happens to track.</summary>
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
