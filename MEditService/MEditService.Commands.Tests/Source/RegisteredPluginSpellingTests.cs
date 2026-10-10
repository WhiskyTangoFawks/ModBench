using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
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

        var result = await TrackEveryPluginOf.ModAsync(scratch.LoadOrder, Origin);

        Assert.Empty(result.Refused);
        var repository = TestAdapters.Source().Open(TestMod.Of(scratch.Plugin, scratch.ModFolder), Release).Require();
        Assert.NotEmpty(repository.FormKeysUsed(scratch.Plugin).Value());
        Assert.Empty(repository.ChangedSinceLastCommit(scratch.Plugin).Value());
    }

    [Fact]
    public async Task Compile_OfAPluginWithAMixedCaseExtension_ReadsTheSourceRootAsRegistered()
    {
        using var scratch = new ModFolderUnderAnInstanceRootScratch();
        Assert.Empty((await TrackEveryPluginOf.ModAsync(scratch.LoadOrder, Origin)).RefusalMessages());

        await CompileServices.Over(scratch.LoadOrder).CompileLandedAsync(scratch.Plugin);
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
                [new LoadOrderEntry(PluginName, PluginPath, Origin, Line: 0, Enabled: true, Winning: true)]);
        }

        private string PluginPath => Path.Combine(ModFolder, PluginName);

        public void Dispose()
        {
            _instanceRoot.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
