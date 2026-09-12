using MEditService.Commands.Edits;
using MEditService.Commands;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda;

namespace MEditService.Tests.Source;

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

        var result = await new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(scratch.LoadOrder, [scratch.Plugin], Origin, SourcePreset.Edits);

        Assert.True(result.Applied, result.Message);
        // git's index is case-sensitive on every platform, so the committed paths are the portable
        // statement of where a reader finds the tree.
        var committed = GitCli.Run(scratch.GitDirectory, scratch.ModFolder, "ls-files").Split('\n');
        Assert.Contains("source/Mixed.ESP/RecordData.json", committed);
        Assert.DoesNotContain(
            committed, path => path.StartsWith("source/Mixed.esp/", StringComparison.Ordinal));
    }

    [Fact]
    public void Compile_OfAPluginWithAMixedCaseExtension_ReadsTheSourceRootAsRegistered()
    {
        using var scratch = new ModFolderScratch();
        scratch.TrackFromPristineFiles();

        var result = CompileServices.Over(scratch.LoadOrder).Compile(scratch.Plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    // The mod folder under an instance root, as MO2 lays it out, holding one mixed-case plugin.
    private sealed class ModFolderScratch : IDisposable
    {
        private readonly string _instanceRoot = Directory.CreateTempSubdirectory("medit-spelling-instance-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-spelling-game-").FullName;

        public string ModFolder { get; }
        internal PluginKey Plugin { get; } = new(PluginName, Origin);
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
            var deepParsed = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(PluginName), PluginPath), Release);
            var pristineFiles = SourceRepository.PristineFilesOf(
                PluginName, PluginTrees.SerializeTree(deepParsed).GetAwaiter().GetResult());

            SourceRepository.Track(
                ModFolder, SourcePreset.Edits, pristineFiles,
                new TrackProvenance(null, null, new Dictionary<string, string>()));
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
