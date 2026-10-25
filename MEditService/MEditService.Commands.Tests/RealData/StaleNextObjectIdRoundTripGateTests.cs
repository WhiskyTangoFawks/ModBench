using MEditService.Commands.Build;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.RealData;

public sealed class StaleNextObjectIdRoundTripGateTests
{
    public static TheoryData<string> GeneratedPluginsWithAStaleHeader => new()
    {
        StaleHeaderPlugins.SettingsFileName,
        StaleHeaderPlugins.LightFileName,
        StaleHeaderPlugins.FullFileName,
    };

    [Theory]
    [MemberData(nameof(GeneratedPluginsWithAStaleHeader))]
    public async Task Compile_OfAGeneratedPluginWithAStaleHeader_ReproducesTheSourceContent(string fileName)
    {
        using var scratch = new CompiledPluginScratch(fileName);
        using var before = new ScratchDirectory("medit-stale-header-before-");
        var original = Path.Combine(before, fileName);
        File.Copy(scratch.PluginPath, original);
        await scratch.DecompileAndCommitAsync();

        await scratch.CompileService().CompileLandedAsync(scratch.Plugin);

        var divergence = TestAdapters.Mutagen().DivergenceFrom(
            fileName, original, scratch.PluginPath, EmptyLoadOrder.Of(GameRelease.Fallout4), HandedStrings.Of(original)).Answered();
        Assert.Null(divergence);
    }

    [Fact]
    public async Task DecompileAndCommit_WithAnExtraRecordInTheRecompiledPlugin_NamesThatRecord()
    {
        using var scratch = new CompiledPluginScratch(StaleHeaderPlugins.SettingsFileName);
        FormKey? extra = null;

        async Task<IMod> DeserializeThenAddAnNpc(string folder, CancellationToken ct)
        {
            var deserialized = await Fallout4WholeMod.Deserialize(folder, ct);
            extra = deserialized.Npcs.AddNew("ExtraNpc").FormKey;
            return deserialized;
        }

        var result = await scratch.DecompileAndCommitAsync(DeserializeThenAddAnNpc);

        Assert.False(result.Applied);
        Assert.Equal(DecompileAndCommitRefusal.RoundTripFailed, result.Refusal);

        var extraFormKey = extra
            ?? throw new InvalidOperationException("Expected DeserializeThenAddAnNpc to run and set extra.");
        Assert.Contains(extraFormKey.ToString(), result.Message);
        Assert.Contains("ExtraNpc", result.Message);
        Assert.Contains("not present in the original", result.Message);
    }

    private sealed class CompiledPluginScratch : IDisposable
    {
        private readonly LoadOrderHolder _holder = new();
        private readonly ScratchDirectory _dataFolder = new("medit-stale-header-data-");
        private readonly ScratchDirectory _modFolder = new("medit-stale-header-");
        private readonly LoadOrderSnapshot _loadOrder;

        public string PluginPath { get; }
        public PluginAddress Plugin { get; }

        public CompiledPluginScratch(string fileName)
        {
            PluginPath = Path.Combine(_modFolder, fileName);
            StaleHeaderPlugins.Named(fileName).WriteInto(_modFolder);
            Plugin = new PluginAddress(fileName, "FixtureMod");

            _loadOrder = EmptyMasterStubs.LoadOrderOver(PluginPath, Plugin.Origin, _dataFolder);
            _holder.Apply(_loadOrder);
        }

        public async Task<PluginDecompiledAndCommitted> DecompileAndCommitAsync(Func<string, CancellationToken, Task<IMod>>? deserialize = null) =>
            (await DecompileAndCommitEveryPluginOf.ModAsync(
                _loadOrder, Plugin.Origin,
                deserialize is { } forged ? new ForgedTreeWriteAdapter(forged) : null)).Only();

        public CompilePluginHandler CompileService() => TestEditService.CompileHandler(_holder);

        public void Dispose()
        {
            _modFolder.Dispose();
            _dataFolder.Dispose();
        }
    }
}
