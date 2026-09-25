using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.RealData;

/// <summary>Nothing in-game reads <c>HEDR.NextObjectID</c>/<c>NumRecords</c> and authoring tools
/// leave them stale, so fidelity means the stored value verbatim. Real plugins, since the
/// Mutagen-written fixture cannot show it.</summary>
public sealed class StaleNextObjectIdRoundTripGateTests
{
    public static TheoryData<string, uint, uint> Fixtures => new()
    {
        { "LitR - Settings Holotapes Sorting.esp", 2, 16 },
        { "RecruitSierra.esl", 17098, 148 },
        { "Hitech Trashcans to BOS.esp", 43, 150 },
    };

    public static TheoryData<string> TrackAndCompileFixtures => new()
    {
        "LitR - Settings Holotapes Sorting.esp",
        "RecruitSierra.esl",
        "Hitech Trashcans to BOS.esp",
    };

    private static string FixturePath(string fileName) => Path.Combine(AppContext.BaseDirectory, "TestData", fileName);

    [Theory]
    [MemberData(nameof(Fixtures))]
    public async Task Save_OfARealPluginWithAStaleHeader_PreservesNextObjectIdAndNumRecords(
        string fileName, uint storedNextObjectId, uint storedNumRecords)
    {
        using var scratch = new TrackedScratch(fileName);
        Assert.Equal((storedNextObjectId, storedNumRecords), ReadHeaderStats(scratch.PluginPath));

        await new PluginWriter(NullLogger<PluginWriter>.Instance).SaveAsync(scratch.PluginPath, GameRelease.Fallout4);

        Assert.Equal((storedNextObjectId, storedNumRecords), ReadHeaderStats(scratch.PluginPath));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileFixtures))]
    public async Task Track_OfARealPluginWithAStaleHeader_Succeeds(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Theory]
    [MemberData(nameof(TrackAndCompileFixtures))]
    public async Task Compile_OfARealPluginWithAStaleHeader_ReproducesTheSourceContent(string fileName)
    {
        using var scratch = new TrackedScratch(fileName);
        var original = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), scratch.PluginPath), Fallout4Release.Fallout4);
        await scratch.TrackAsync();

        var result = await scratch.CompileService().CompileAsync(scratch.Plugin, new CompileSource.WorkingTree());
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

    // Empty master stubs: compile orders the master list from the load order (ADR-0008), which needs
    // the names present, not their content.
    private sealed class TrackedScratch : IDisposable
    {
        internal LoadOrderHolder Holder { get; } = new();
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-stale-header-game-").FullName;
        private readonly LoadOrderSnapshot _loadOrder;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-stale-header-").FullName;
        public string PluginPath { get; }
        public PluginAddress Plugin { get; }

        public TrackedScratch(string fileName)
        {
            PluginPath = Path.Combine(ModFolder, fileName);
            File.Copy(FixturePath(fileName), PluginPath);
            Plugin = new PluginAddress(fileName, "FixtureMod");

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(fileName), PluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(fileName, PluginPath, Plugin.Origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = new LoadOrderSnapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, SnapshotCopies.Of(inputs));
            Holder.Apply(_loadOrder);
        }

        public async Task<TrackResult> TrackAsync(TreeDeserializer? deserialize = null) =>
            (await new TrackService(
                    NullLogger<TrackService>.Instance,
                    deserialize is { } forged ? new ForgedTreeWriteAdapter(Plugin.Name, forged) : TestAdapters.Mutagen())
                .TrackModAsync(_loadOrder, Plugin.Origin, SourcePreset.Edits)).Only();

        public PluginCompileService CompileService() =>
            CompileServices.Over(Holder.Current);

        public void Dispose()
        {
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
