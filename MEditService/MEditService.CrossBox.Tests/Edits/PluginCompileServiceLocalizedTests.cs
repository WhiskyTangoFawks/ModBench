using MEditService.Codec.Schema;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Tests.Edits;

/// <summary>Its own small fixture rather than <see cref="CompileFixture"/>: none of that fixture's
/// records carry a translated string.</summary>
public sealed class PluginCompileServiceLocalizedTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string Origin = "FixtureMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-compile-localized-").FullName;
    private readonly string _gameDir = Directory.CreateTempSubdirectory("medit-compile-localized-game-").FullName;
    private readonly LoadOrderSnapshot _loadOrder;

    public PluginCompileServiceLocalizedTests()
    {
        var pluginPath = Path.Combine(_modFolder, PluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var door = mod.Doors.AddNew("MainDoor");
        door.Name = new TranslatedString(Language.English, "The Big Door");
        mod.UsingLocalization = true;
        mod.WriteToBinary(pluginPath);

        _loadOrder = new LoadOrderSnapshot(
            _gameDir, instanceRoot: null, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));

        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(_loadOrder, [new PluginCopyKey(PluginName, Origin)], Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        Directory.Delete(_modFolder, recursive: true);
        Directory.Delete(_gameDir, recursive: true);
    }

    // The destination Strings files are deleted first because Mutagen auto-attaches a StringsWriter
    // rooted at the temp write path when none is supplied, which Commit never moves: a byte-compare
    // against files compile never touched would otherwise pass vacuously.
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

        var plugin = new PluginCopyKey(PluginName, Origin);
        var compileService = CompileServices.Over(_loadOrder);
        var result = compileService.Compile(plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);

        // The recompiled binary keeps the Localized flag.
        using var overlayDisposable = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(PluginName), pluginPath), GameRelease.Fallout4,
            LocalizedStrings.ForRead(new PluginStrings(_modFolder, _gameDir)));
        Assert.True(((IFallout4ModGetter)overlayDisposable).UsingLocalization);

        // Every strings file compile rewrote is byte-identical to what Track captured. A real change
        // (StringsWriter re-assigns sequential keys in registration order) would show up here even though
        // the .esp's own bytes already round-trip.
        foreach (var (fileName, originalBytes) in originalStringsFiles)
        {
            var recompiledPath = Path.Combine(stringsDir, fileName);
            Assert.True(File.Exists(recompiledPath), $"expected {recompiledPath}");
            Assert.True(originalBytes.AsSpan().SequenceEqual(File.ReadAllBytes(recompiledPath)),
                $"{fileName} differs after compile.");
        }
    }
}
