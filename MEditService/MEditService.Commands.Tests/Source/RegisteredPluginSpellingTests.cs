using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Source;

/// <summary>A source tree's root is the plugin's name as the load order spells it: a ModKey renders
/// the extension lowercase, so <c>Mixed.ESP</c> would be written under one root and read from
/// another.</summary>
public sealed class RegisteredPluginSpellingTests
{
    private const string Origin = "SpellingMod";
    private const string PluginName = "Mixed.ESP";
    private const GameRelease Release = GameRelease.Fallout4;

    [Fact]
    public async Task Track_OfAPluginWithAMixedCaseExtension_CommitsItsSourceRootAsRegistered()
    {
        using var scratch = new ModFolderScratch();

        var result = await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(scratch.LoadOrder, Origin, SourcePreset.Edits);

        Assert.Empty(result.Refused);
        // git's index is case-sensitive on every platform, so the committed paths are the portable
        // statement of where a reader finds the tree.
        var committed = GitProbe.Run(scratch.GitDirectory, scratch.ModFolder, "ls-files").Split('\n');
        Assert.Contains("source/Mixed.ESP/RecordData.json", committed);
        Assert.DoesNotContain(
            committed, path => path.StartsWith("source/Mixed.esp/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Compile_OfAPluginWithAMixedCaseExtension_ReadsTheSourceRootAsRegistered()
    {
        using var scratch = new ModFolderScratch();
        scratch.TrackFromPristineFiles();

        var result = await CompileServices.Over(scratch.LoadOrder).CompileAsync(scratch.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    // The mod folder under an instance root, as MO2 lays it out, holding one mixed-case plugin.
    private sealed class ModFolderScratch : IDisposable
    {
        private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-spelling-instance-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-spelling-game-").FullName;

        public string ModFolder { get; }
        internal PluginAddress Plugin { get; } = new(PluginName, Origin);
        internal LoadOrderSnapshot LoadOrder { get; }

        internal ModFolderScratch()
        {
            ModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SpellingNpc");
            mod.WriteToBinary(PluginPath);

            LoadOrder = new LoadOrderSnapshot(
                _gameDirectory, _instanceRoot, Release,
                SnapshotCopies.Of([new LoadOrderEntry(PluginName, PluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
        }

        internal string GitDirectory => Path.Combine(ModFolder, ".git");

        private string PluginPath => Path.Combine(ModFolder, PluginName);

        // Tracked without Track, so the compile door is read on a tree whose root is spelled as
        // registered whatever the Track door does with the name.
        internal void TrackFromPristineFiles()
        {
            var (treeFiles, _) = TestAdapters.Mutagen().ReadSourceAsync(
                new ModPath(ModKey.FromFileName(PluginName), PluginPath), PluginName, Release,
                PluginStrings.In(ModFolder)).GetAwaiter().GetResult();
            var pristineFiles = SourceRepository.PristineFilesOf(PluginName, treeFiles);

            PluginBaselines.Track(
                ModFolder, SourcePreset.Edits, pristineFiles);
        }

        public void Dispose()
        {
            SafeDelete(_instanceRoot);
            SafeDelete(_gameDirectory);
        }

        private static void SafeDelete(string folder)
        {
            try { Directory.Delete(folder, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
