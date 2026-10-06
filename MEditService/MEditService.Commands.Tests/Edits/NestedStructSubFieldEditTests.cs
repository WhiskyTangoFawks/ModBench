using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class NestedStructSubFieldEditTests : IDisposable
{
    private const string NearSelfBecausePlvdBinaryDiscriminatorIsTheTypeValue = "NearSelf";

    private readonly FactionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void VendorLocationTarget_NamedInPayload_RoundTripsAndSwitchesTheLeafFromTheTrackedLocationTargetToLocationFallback()
    {
        Assert.Contains("\"MutagenObjectType\": \"LocationTarget\"", _fixture.Body(), StringComparison.Ordinal);

        var result = _fixture.Service().Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json($$$"""
            {"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "{{{NearSelfBecausePlvdBinaryDiscriminatorIsTheTypeValue}}}", "Data": 3}}
            """));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.Body();
        Assert.Contains("\"MutagenObjectType\": \"LocationFallback\"", body, StringComparison.Ordinal);
        Assert.Contains("\"Radius\": 99", body, StringComparison.Ordinal);
        Assert.Contains("\"Data\": 3", body, StringComparison.Ordinal);
    }

    [Fact]
    public void VendorLocationTarget_SecondEditOfOneLeaf_KeepsUnnamedMembers()
    {
        var service = _fixture.Service();
        var first = service.Set(_fixture.Plugin, _fixture.Faction.ToString(), "VendorLocation",
            Json($$$"""{"Target": {"MutagenObjectType": "LocationFallback", "Type": "{{{NearSelfBecausePlvdBinaryDiscriminatorIsTheTypeValue}}}", "Data": 3}}"""));
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
            Json($$$"""
            {"Radius": 99, "Target": {"MutagenObjectType": "LocationFallback", "Type": "{{{NearSelfBecausePlvdBinaryDiscriminatorIsTheTypeValue}}}", "Data": "not-a-number"}}
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Equal(before, _fixture.Body());
        Assert.Contains("\"Radius\": 1", _fixture.Body(), StringComparison.Ordinal);
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

        private readonly ScratchDirectory _modFolder = new("medit-642-mod-");
        private readonly ScratchDirectory _gameDirectory = new("medit-642-game-");

        public PluginAddress Plugin { get; } = new(PluginName, Origin);
        public LoadOrderSnapshot LoadOrder { get; }
        public TestEditor EditHandler { get; }
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

            TrackedTemplates.WriteTracked(_modFolder, mod);

            LoadOrder = SnapshotPlugins.Snapshot(
                _gameDirectory, _gameDirectory, GameRelease.Fallout4,
                [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)]);

            holder.Apply(LoadOrder);
            EditHandler = TestEditService.EditHandler(holder);
        }

        public TestEditor Service() => EditHandler;

        public string Body() => TrackedTree.Body(_modFolder, Plugin, Faction.ToString());

        public void Dispose()
        {
            _modFolder.Dispose();
            _gameDirectory.Dispose();
        }
    }
}
