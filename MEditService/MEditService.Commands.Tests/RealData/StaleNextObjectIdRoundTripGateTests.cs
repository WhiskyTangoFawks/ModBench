using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.RealData;

public sealed class StaleNextObjectIdRoundTripGateTests
{
    public static TheoryData<string, uint, uint, uint> RealFixturesWithAStaleHeader => new()
    {
        { "LitR - Settings Holotapes Sorting.esp", 2, 16, 18 },
        { "RecruitSierra.esl", 17098, 148, 145 },
        { "Hitech Trashcans to BOS.esp", 43, 150, 149 },
    };

    public static TheoryData<string> TrackAndCompileRealFixtures => new()
    {
        "LitR - Settings Holotapes Sorting.esp",
        "RecruitSierra.esl",
        "Hitech Trashcans to BOS.esp",
    };

    private static string FixturePath(string fileName) => Path.Combine(AppContext.BaseDirectory, "TestData", fileName);

    [Theory]
    [MemberData(nameof(RealFixturesWithAStaleHeader))]
    public async Task Save_OfARealPluginWithAStaleHeader_DerivesNextObjectIdAndNumRecordsFromContent(
        string fileName, uint storedNextObjectId, uint storedNumRecords, uint derivedNumRecords)
    {
        using var scratch = new TrackedScratch(fileName);
        Assert.Equal((storedNextObjectId, storedNumRecords), ReadHeaderStats(scratch.PluginPath));
        var oneAboveTheHighestNativeId = HighestNativeId(scratch.PluginPath) + 1;

        using (var prep = await TreeSaves.PrepareAsync(scratch.PluginPath))
        {
            prep.Commit();
        }

        Assert.Equal((oneAboveTheHighestNativeId, derivedNumRecords), ReadHeaderStats(scratch.PluginPath));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileRealFixtures))]
    public async Task Track_OfARealPluginWithAStaleHeader_Succeeds(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileRealFixtures))]
    public async Task Compile_OfARealPluginWithAStaleHeader_ReproducesTheSourceContent(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var original = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        await scratch.TrackAsync();

        var result = await scratch.CompileService().CompileOneAsync(scratch.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        var compiled = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        var divergence = ModelIdentity.FindFirstDivergence(original, compiled);
        Assert.Null(divergence);
    }

    [Fact]
    public async Task Track_WithAnExtraRecordInTheRecompiledPlugin_NamesThatRecord()
    {
        using var scratch = new TrackedScratch("LitR - Settings Holotapes Sorting.esp");
        FormKey? extra = null;

        async Task<IMod> DeserializeThenAddAnNpc(string folder, CancellationToken ct)
        {
            var deserialized = await RecordTextCodecGeneratorSeed.DeserializeWholeMod(folder, InlineWorkDropoff.Instance, ct);
            extra = deserialized.Npcs.AddNew("ExtraNpc").FormKey;
            return deserialized;
        }

        var result = await scratch.TrackAsync(DeserializeThenAddAnNpc);

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        var extraFormKey = extra
            ?? throw new InvalidOperationException("Expected DeserializeThenAddAnNpc to run and set extra.");
        Assert.Contains(extraFormKey.ToString(), result.Message);
        Assert.Contains("ExtraNpc", result.Message);
        Assert.Contains("not present in the original", result.Message);
    }

    private static (uint NextObjectId, uint NumRecords) ReadHeaderStats(string pluginPath)
    {
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName(Path.GetFileName(pluginPath)), pluginPath), Fallout4Release.Fallout4);
        return (overlay.ModHeader.Stats.NextFormID, overlay.ModHeader.Stats.NumRecords);
    }

    private static uint HighestNativeId(string pluginPath)
    {
        var modKey = ModKey.FromFileName(Path.GetFileName(pluginPath));
        using var overlay = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(modKey, pluginPath), Fallout4Release.Fallout4);
        return overlay.EnumerateMajorRecords().Where(r => r.FormKey.ModKey == modKey).Max(r => r.FormKey.ID);
    }

    private sealed class TrackedScratch : IDisposable
    {
        internal LoadOrderHolder Holder { get; } = new();
        private readonly ScratchDirectory _gameDirectory = new("medit-stale-header-game-");
        private readonly LoadOrderSnapshot _loadOrder;

        public ScratchDirectory ModFolder { get; } = new("medit-stale-header-");
        public string PluginPath { get; }
        public PluginAddress Plugin { get; }

        public TrackedScratch(string fileName)
        {
            PluginPath = Path.Combine(ModFolder, fileName);
            File.Copy(FixturePath(fileName), PluginPath);
            Plugin = new PluginAddress(fileName, "FixtureMod");

            _loadOrder = EmptyMasterStubs.LoadOrderOver(PluginPath, Plugin.Origin, _gameDirectory);
            Holder.Apply(_loadOrder);
        }

        public async Task<PluginTrack> TrackAsync(Func<string, CancellationToken, Task<IMod>>? deserialize = null) =>
            (await TrackEveryPluginOf.ModAsync(
                _loadOrder, Plugin.Origin,
                deserialize is { } forged ? new ForgedTreeWriteAdapter(Plugin.Name, forged) : null)).Only();

        public CompilePluginHandler CompileService() =>
            CompileServices.Over(Holder.Current);

        public void Dispose()
        {
            ModFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
