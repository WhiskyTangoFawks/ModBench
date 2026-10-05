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

public sealed class RegisteredPluginSpellingTests
{
    private const string Origin = "SpellingMod";
    private const string PluginName = "Mixed.ESP";
    private const GameRelease Release = GameRelease.Fallout4;

    [Fact]
    public async Task Track_OfAPluginWithAMixedCaseExtension_CommitsItsSourceRootAsRegistered()
    {
        using var scratch = new ModFolderUnderAnInstanceRootScratch();

        var result = await new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
            .TrackModAsync(scratch.LoadOrder, Origin);

        Assert.Empty(result.Refused);
        var repository = SourceRepository.Open(TestMod.In(scratch.ModFolder), Release).Require();
        Assert.NotEmpty(repository.FormKeysUsed(scratch.Plugin));
        Assert.Empty(repository.ChangedSinceLastCommit(
            scratch.Plugin, SharedSchemaReflector.Instance.GetSchemas(Release)));
    }

    [Fact]
    public async Task Compile_OfAPluginWithAMixedCaseExtension_ReadsTheSourceRootAsRegistered()
    {
        using var scratch = new ModFolderUnderAnInstanceRootScratch();
        scratch.TrackWithoutTheTrackDoor();

        var result = await CompileServices.Over(scratch.LoadOrder).CompileOneAsync(scratch.Plugin);

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    private sealed class ModFolderUnderAnInstanceRootScratch : IDisposable
    {
        private readonly ScratchDirectory _instanceRoot = new("medit-spelling-instance-");
        private readonly ScratchDirectory _gameDirectory = new("medit-spelling-game-");

        public string ModFolder { get; }
        internal PluginAddress Plugin { get; } = new(PluginName, Origin);
        internal LoadOrderSnapshot LoadOrder { get; }

        internal ModFolderUnderAnInstanceRootScratch()
        {
            ModFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            mod.Npcs.AddNew("SpellingNpc");
            mod.WriteToBinary(PluginPath);

            LoadOrder = SnapshotPlugins.Snapshot(
                _gameDirectory, _instanceRoot, Release,
                [new LoadOrderEntry(PluginName, PluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]);
        }

        private string PluginPath => Path.Combine(ModFolder, PluginName);

        internal void TrackWithoutTheTrackDoor()
        {
            var (treeFiles, _) = TestAdapters.Mutagen().ReadSourceAsync(
                new ModPath(ModKey.FromFileName(PluginName), PluginPath), PluginName, Release,
                PluginStrings.In(ModFolder)).GetAwaiter().GetResult();
            var pristineFiles = SourceRepository.PristineFilesOf(PluginName, treeFiles);

            SourceRepository.Track(
                ModFolder, [(pristineFiles, new DecompiledPlugin(PluginName, null))]);
        }

        public void Dispose()
        {
            _instanceRoot.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
