using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.RealData;

/// <summary>Real plugins whose bytes trip the walker's master-pruning false positive must Track (ADR-0008);
/// SpaDia_AMR is refused, since Mutagen-#688 hides its real use of a master.</summary>
public sealed class MasterPruningRoundTripGateTests
{
    private const string FaceGenFixtureFileName = "FaceGen Output.esp";
    private const string LegendariesFixtureFileName = "LegendariesTheyCanUse.esp";
    private const string SpaDiaAmrFixtureFileName = "SpaDia_AMR.esp";

    // In file order, as LegendariesTheyCanUse.esp's TES4 header declares them.
    private static readonly string[] DeclaredMasters =
        ["Fallout4.esm", "DLCRobot.esm", "DLCCoast.esm", "DLCNukaWorld.esm"];

    // Minus DLCRobot.esm, the one no record in the file references.
    private static readonly string[] MastersSurvivingThePrune =
        ["Fallout4.esm", "DLCCoast.esm", "DLCNukaWorld.esm"];

    private static string PathTo(string fixtureFileName) =>
        Path.Combine(AppContext.BaseDirectory, "TestData", fixtureFileName);

    [Fact]
    public async Task TrackAsync_OfTheRealFaceGenOutputFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(FaceGenFixtureFileName, "FaceGenMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfTheRealLegendariesFixture_AcceptsDespiteThePrunedUnusedMaster()
    {
        using var scratch = new PrunedMasterScratch(LegendariesFixtureFileName, "LegendariesMod");

        await scratch.TrackAsync();

        Assert.True(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public async Task TrackAsync_OfTheRealSpaDiaAMRFixture_RefusesNamingTheQuestAndThePrunedMaster()
    {
        using var scratch = new PrunedMasterScratch(SpaDiaAmrFixtureFileName, "SpaDiaAMRMod");

        var result = await scratch.TrackAsync();

        Assert.False(result.Applied);
        Assert.Equal(TrackRefusal.RoundTripFailed, result.Refusal);

        Assert.Contains("DiaQ_LLInjector_SpadeyAMR", result.Message);
        Assert.Contains("DLCNukaWorld.esm", result.Message);
        Assert.Contains("Mutagen #688", result.Message);
        Assert.False(SourceRepository.IsTracked(scratch.ModFolder));
    }

    [Fact]
    public void DeepParse_OfTheRealLegendariesFixture_KeepsEveryDeclaredMasterIncludingTheUnreferencedOne()
    {
        var deepParsed = DeepParseLegendaries();

        Assert.Equal(DeclaredMasters, deepParsed.MasterReferences.Select(master => master.Master.FileName.String));

        // ...and the rewrite prunes DLCRobot.esm precisely because nothing in the file names it, by record
        // or by link. The other three are referenced and survive: content-derived pruning (ADR-0008).
        var referenced = deepParsed.EnumerateMajorRecords().Select(record => record.FormKey.ModKey)
            .Concat(deepParsed.EnumerateFormLinks().Select(link => link.FormKey.ModKey))
            .ToHashSet();

        Assert.DoesNotContain(ModKey.FromFileName("DLCRobot.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("Fallout4.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("DLCCoast.esm"), referenced);
        Assert.Contains(ModKey.FromFileName("DLCNukaWorld.esm"), referenced);
    }

    [Fact]
    public async Task SourceRoundTrip_OfTheRealLegendariesFixture_KeepsEveryDeclaredMaster()
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-masterprune-source-").FullName;
        try
        {
            var fromSource = await DeserializeLegendariesThroughSource(scratchDir);

            Assert.Equal(DeclaredMasters, fromSource.MasterReferences.Select(master => master.Master.FileName.String));
        }
        finally { Directory.Delete(scratchDir, recursive: true); }
    }

    [Fact]
    public async Task SourceRoundTripWrite_OfTheRealLegendariesFixture_PrunesOnlyTheUnreferencedMaster()
    {
        var scratchDir = Directory.CreateTempSubdirectory("medit-masterprune-write-").FullName;
        try
        {
            var fromSource = await DeserializeLegendariesThroughSource(scratchDir);
            var rewrittenPath = Path.Combine(scratchDir, LegendariesFixtureFileName);
            await fromSource.BeginWrite
                .ToPath(rewrittenPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck)
                .WriteAsync();

            var rewritten = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), rewrittenPath), Fallout4Release.Fallout4);

            Assert.Equal(
                MastersSurvivingThePrune,
                rewritten.ModHeader.MasterReferences.Select(master => master.Master.FileName.String));
        }
        finally { Directory.Delete(scratchDir, recursive: true); }
    }

    private static IMod DeepParseLegendaries()
    {
        var fixturePath = PathTo(LegendariesFixtureFileName);
        return ModFactory.ImportSetter(
            new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), fixturePath),
            GameRelease.Fallout4,
            RealPluginReadParameters.For(PluginStrings.In((Path.GetDirectoryName(fixturePath) ?? throw new InvalidOperationException("Expected a parent directory.")))));
    }

    private static async Task<IFallout4Mod> DeserializeLegendariesThroughSource(string scratchDir)
    {
        var fixturePath = PathTo(LegendariesFixtureFileName);
        var modPath = new ModPath(ModKey.FromFileName(LegendariesFixtureFileName), fixturePath);
        var (files, _) = await TestAdapters.Mutagen().ReadSourceAsync(
            modPath, LegendariesFixtureFileName, GameRelease.Fallout4,
            PluginStrings.In((Path.GetDirectoryName(fixturePath) ?? throw new InvalidOperationException("Expected a parent directory."))));

        foreach (var file in files)
        {
            var fullPath = Path.Combine(scratchDir, file.RelativePath);
            Directory.CreateDirectory((Path.GetDirectoryName(fullPath) ?? throw new InvalidOperationException("Expected a parent directory.")));
            await File.WriteAllBytesAsync(fullPath, file.Content);
        }

        return await RecordTextCodecGeneratorSeed.DeserializeWholeMod(
            scratchDir, InlineWorkDropoff.Instance, CancellationToken.None);
    }

    // Empty master stubs satisfy Track's read; which of them survive the write back out is what these
    // fixtures test.
    private sealed class PrunedMasterScratch : IDisposable
    {
        private readonly string _fixtureFileName;
        private readonly string _origin;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-masterprune-game-").FullName;
        private readonly LoadOrderSnapshot _loadOrder;

        public string ModFolder { get; } = Directory.CreateTempSubdirectory("medit-masterprune-").FullName;

        public PrunedMasterScratch(string fixtureFileName, string origin)
        {
            _fixtureFileName = fixtureFileName;
            _origin = origin;

            var pluginPath = Path.Combine(ModFolder, _fixtureFileName);
            File.Copy(PathTo(_fixtureFileName), pluginPath);

            var inputs = new List<LoadOrderEntry>();
            using (var overlay = Fallout4Mod.CreateFromBinaryOverlay(
                new ModPath(ModKey.FromFileName(_fixtureFileName), pluginPath), Fallout4Release.Fallout4))
            {
                foreach (var master in overlay.ModHeader.MasterReferences)
                {
                    var stubPath = Path.Combine(_gameDirectory, master.Master.FileName);
                    new Fallout4Mod(master.Master, Fallout4Release.Fallout4).WriteToBinary(stubPath);
                    inputs.Add(new LoadOrderEntry(master.Master.FileName, stubPath, "Stubs", Slot: inputs.Count, Enabled: true, Winning: true));
                }
            }
            inputs.Add(new LoadOrderEntry(_fixtureFileName, pluginPath, _origin, Slot: inputs.Count, Enabled: true, Winning: true));

            _loadOrder = new LoadOrderSnapshot(_gameDirectory, instanceRoot: null, GameRelease.Fallout4, SnapshotCopies.Of(inputs));
        }

        public Task<TrackResult> TrackAsync() =>
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackAsync(_loadOrder, _origin, SourcePreset.Edits);

        public void Dispose()
        {
            try { Directory.Delete(ModFolder, recursive: true); } catch (IOException) { }
            try { Directory.Delete(_gameDirectory, recursive: true); } catch (IOException) { }
        }
    }
}
