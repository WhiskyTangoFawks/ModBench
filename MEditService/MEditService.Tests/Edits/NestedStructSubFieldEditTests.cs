using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Codec.Schema;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary><c>Faction.VendorLocation.Target</c> as the subject: its <c>LocationFallback</c> leaf
/// has no FormLink members, so this fixture needs no supporting cast of linked records.</summary>
public sealed class NestedStructSubFieldEditTests : IDisposable
{
    private readonly FactionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // PLVD's binary discriminator is its Type value, so the seeded LocationFallback reparses as a
    // LocationTarget through Track: this write switches the concrete leaf as well as the value.
    [Fact]
    public void VendorLocationTarget_NamedInPayload_RoundTrips()
    {
        var result = _fixture.Service().Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""
            {"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": 3}}
            """));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Radius\": 99", body, StringComparison.Ordinal);
        Assert.Contains("\"Data\": 3", body, StringComparison.Ordinal);
    }

    // One leaf, one change: the siblings the gesture never named stay as they were.
    [Fact]
    public void VendorLocationTarget_SecondEditOfOneLeaf_KeepsUnnamedMembers()
    {
        var service = _fixture.Service();
        var first = service.Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""{"Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": 3}}"""));
        Assert.True(first.Applied, first.Message);

        var second = service.Edit(_fixture.Plugin, _fixture.Faction.ToString(),
            SetAt(Json("5"), Member("VendorLocation"), Member("Target"), Member("Data")));

        Assert.True(second.Applied, second.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Data\": 5", body, StringComparison.Ordinal);
        Assert.Contains("\"Type\": \"NearSelf\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public void VendorLocation_BadNestedMemberValue_RefusesWholeWriteAndLeavesWorkingTreeUntouched()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""
            {"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "NearSelf", "Data": "not-a-number"}}
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal(before, _fixture.Body());
        Assert.Contains("\"Radius\": 1", _fixture.Body(), StringComparison.Ordinal);
    }

    [Fact]
    public void VendorLocationTarget_MissingDiscriminator_RefusesAndWritesNothing()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""{"Radius": 99, "Target": {"Type": "NearSelf", "Data": 3}}"""));

        Assert.False(result.Applied);
        Assert.Equal(before, _fixture.Body());
    }

    [Fact]
    public void VendorLocation_PayloadOmittingTarget_StillAppliesBothWritableSiblings()
    {
        var result = _fixture.Service().Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json("""{"Radius": 99, "CollectionIndex": 2}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Radius\": 99", body, StringComparison.Ordinal);
        Assert.Contains("\"CollectionIndex\": 2", body, StringComparison.Ordinal);
    }

    private sealed class FactionFixture : IDisposable
    {
        private const string PluginName = "Faction642.esp";
        private const string Origin = "Faction642Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-642-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-642-game-").FullName;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public EditRecordHandler EditHandler { get; }
        public FormKey Faction { get; }

        public FactionFixture()
        {
            var holder = new LoadOrderHolder();
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var faction = mod.Factions.AddNew("Faction642");
            faction.VendorLocation = new LocationTargetRadius
            {
                Radius = 1,
                CollectionIndex = 0,
                Target = new LocationFallback
                {
                    Type = LocationTargetRadius.LocationType.NearReference,
                    Data = 0,
                },
            };
            Faction = faction.FormKey;

            mod.WriteToBinary(pluginPath);

            LoadOrder = new LoadOrderSnapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                SnapshotCopies.Of([new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]));
            new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
                .TrackAsync(LoadOrder, [Plugin], Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
        }

        public EditRecordHandler Service() => EditHandler;

        public string Body() => TrackedTree.Document(_modFolder, Plugin, Faction.ToString())!.Body;

        public void Dispose()
        {
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
