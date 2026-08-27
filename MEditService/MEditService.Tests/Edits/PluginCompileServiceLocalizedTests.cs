using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Edits;

/// <summary>
/// #515 AC1: a tracked Localized plugin compiles with its strings written back beside it — the
/// compile half of the fixture <see cref="Source.TrackServiceTests"/> tracks on the read side.
/// Deliberately its own small fixture rather than <see cref="TrackedModFixture"/>: none of that
/// fixture's records carry a translated string, and widening it would cost every other test in this
/// folder a field they never asked for.
/// </summary>
public sealed class PluginCompileServiceLocalizedTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-compile-localized-").FullName;
    private readonly string _gameDir = Directory.CreateTempSubdirectory("medit-compile-localized-game-").FullName;
    private readonly SessionManager _sessions;

    public PluginCompileServiceLocalizedTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var door = mod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, "The Big Door");
        mod.UsingLocalization = true;
        mod.WriteToBinary(pluginPath);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDir, [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)], GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        Directory.Delete(_modFolder, recursive: true);
        Directory.Delete(_gameDir, recursive: true);
    }

    // Rival observed by hand before this fix (not committed): with PluginWriter.PrepareFromModAsync's
    // WithStringsWriter call removed, Compile still reports success (Mutagen's own
    // PluginUtilityTranslation.SetStringsWriter auto-attaches a writer of its own when none is
    // supplied) — but that auto writer is rooted at the *temp* write path
    // (.medit_tmp_<random>/Strings/), which PreparedPluginSave.Commit never moves and
    // PreparedPluginSave.Dispose's non-recursive Directory.Delete(tmpDir) throws IOException on
    // (silently caught) trying to remove — so the destination Strings/ files are never actually
    // rewritten by compile at all. A byte-compare against files compile never touched would pass
    // vacuously (confirmed: running this test against the reverted fix *without* the delete below
    // passes even though compile wrote nothing — the untouched originals just happen to already be
    // byte-identical to themselves), which is exactly why the destination files are deleted first:
    // with the fix reverted, they never come back and this test fails on the File.Exists check below,
    // not the byte-compare.
    [Fact]
    public void Compile_ALocalizedPlugin_WritesStringsBesideItByteIdenticalToTheInput()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var stringsDir = Path.Combine(_modFolder, "Strings");
        var originalStringsFiles = Directory.GetFiles(stringsDir)
            .ToDictionary(f => Path.GetFileName(f)!, File.ReadAllBytes);
        // Sanity: Track's own fixture setup actually produced strings files to compare against —
        // otherwise every assertion below would vacuously pass over an empty set.
        Assert.NotEmpty(originalStringsFiles);

        // Gone before compile runs, so "byte-identical afterward" can only mean compile itself wrote
        // them — not that nothing ever touched the pre-existing files.
        foreach (var fileName in originalStringsFiles.Keys)
            File.Delete(Path.Combine(stringsDir, fileName));

        var plugin = new PluginKey(PluginName, Origin);
        var compileService = new PluginCompileService(
            _sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
        var result = compileService.Compile(plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);

        // AC1: the recompiled binary keeps the Localized flag.
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4,
            LocalizedStrings.ForRead(_modFolder, _gameDir));
        Assert.True(((IFallout4ModGetter)overlayDisposable).UsingLocalization);

        // AC1: every strings file compile just (re)wrote is byte-identical to what Track originally
        // captured — a real change (StringsWriter re-assigns sequential keys in registration order)
        // would show up here even though the .esp's own bytes already round-trip.
        foreach (var (fileName, originalBytes) in originalStringsFiles)
        {
            var recompiledPath = Path.Combine(stringsDir, fileName);
            Assert.True(File.Exists(recompiledPath), $"expected {recompiledPath}");
            Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(recompiledPath)),
                $"{fileName} differs after compile.");
        }
    }
}
