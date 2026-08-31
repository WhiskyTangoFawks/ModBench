using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #642: a payload naming a sub-field one level inside a struct/array column — a nested Loqui
/// struct, general to every such struct and not specific to abstract unions
/// (<c>SchemaReflector.BuildStructSubField</c>'s own <c>Apply: null</c>) — must refuse the whole
/// write, not silently drop the named value while the caller reports success. Found by #611
/// (<see cref="AbstractUnionCompileRoundTripTests"/>'s own doc comment already names this exact
/// defect) and deliberately not fixed there; #643 is the larger "make it actually writable" half.
///
/// <para><c>Faction.VendorLocation.Target</c> (<c>ALocationTarget</c>), not
/// <c>Static.NavmeshGeometry.Parent</c> — both are named in the ticket, but <c>Target</c> defaults to
/// a <c>LocationFallback</c> with no <c>FormLink</c> members at all
/// (<c>references/Mutagen/.../LocationTargetRadius.cs</c>), so this fixture needs no binary-serializable
/// <c>Vertices</c>/<c>Triangles</c> geometry and no supporting cast of linked records —
/// <c>SchemaReflectorLeafCoverageCompletenessTests.CoveredNestedAbstractUnions</c> independently
/// confirms <c>ILocationTargetRadiusGetter.Target</c> is reachable with a real, non-empty sub-schema
/// the same way <c>Parent</c> is.</para>
/// </summary>
public sealed class NestedStructSubFieldRefusalTests : IDisposable
{
    private readonly FactionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>
    /// The defect itself. <c>radius</c> is an ordinary writable sibling of the unwritable
    /// <c>target</c> — sent alongside it, with a genuinely different value than the fixture's own
    /// seed, so a pre-fix run proves the *whole atomic struct write* used to land (CONTEXT.md: a
    /// struct is one atomic value), not just the named sub-field silently vanishing while its
    /// writable sibling landed and the caller still reported success. Post-fix, neither lands: the
    /// working tree is byte-identical, matching the AC's "refuse before anything is written" contract
    /// (<c>RecordEditService</c>'s own class doc comment already promises this for every refusal).
    /// </summary>
    [Fact]
    public void VendorLocationTarget_NamedInPayload_RefusesTheWholeWrite()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""
            {"radius": 99, "target": {"concrete_type": "LocationFallback", "type": "NearReference", "data": 3}}
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NestedFieldReadOnly, result.Refusal);
        Assert.Contains("vendor_location", result.Message, StringComparison.Ordinal);
        Assert.Contains("not yet editable", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Body());
    }

    /// <summary>
    /// AC2 (a struct edit whose payload includes only writable sub-fields still applies exactly as
    /// before) and AC3 (a struct edit whose payload omits the unwritable sub-field entirely still
    /// applies — absence is not targeting) coincide for this fixture: <c>target</c> is
    /// <c>vendor_location</c>'s only unwritable member, so a payload naming just its writable siblings
    /// is simultaneously "only writable fields present" and "the one unwritable field absent". One
    /// test proves both rather than duplicating the same payload under two names.
    ///
    /// <para>The plain AC2 case — a struct with <i>no</i> unwritable sub-field at all, still applying
    /// — already has coverage:
    /// <see cref="ComplexFieldElementEditTests.WeightStruct_WholeObjectWrite_LandsInTheSourceDocument"/>
    /// (<c>Npc.Weight</c>/<c>NpcWeight</c>, an ordinary struct with only scalar members, no nested
    /// Loqui struct anywhere in it) proves that shape untouched by this ticket.</para>
    /// </summary>
    [Fact]
    public void VendorLocation_PayloadOmittingTarget_StillAppliesBothWritableSiblings()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""{"radius": 99, "collection_index": 2}"""));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Radius\": 99", body, StringComparison.Ordinal);
        Assert.Contains("\"CollectionIndex\": 2", body, StringComparison.Ordinal);
    }

    /// <summary>One real mod folder holding one <c>Faction</c> whose <c>VendorLocation</c>
    /// (<c>LocationTargetRadius</c>) is already set, tracked once — the established
    /// self-contained-fixture-per-file convention (<c>ScalarFieldApplierRefusalTests.GlobFixture</c>/
    /// <c>OmodFixture</c>'s own stated reasoning). <c>Target</c> seeds as a <c>LocationFallback</c>
    /// (no <c>FormLink</c>) so no supporting cast of linked records is needed anywhere in this
    /// file.</summary>
    private sealed class FactionFixture : IDisposable
    {
        private const string PluginName = "Faction642.esp";
        private const string Origin = "Faction642Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-642-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-642-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Faction { get; }

        public FactionFixture()
        {
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

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.GetDocument(Faction.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
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
