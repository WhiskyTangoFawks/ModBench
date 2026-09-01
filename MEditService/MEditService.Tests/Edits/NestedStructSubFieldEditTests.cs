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
/// #643: a nested Loqui struct sub-field one level inside a struct column
/// (<c>SchemaReflector.BuildStructSubField</c>) is writable through the one write path, with the
/// same semantics the top-level struct column has (the shared <c>ApplyStructJson</c>). This file
/// was #642's <c>NestedStructSubFieldRefusalTests</c> — the refusal it pinned is deliberately
/// removed by #643 for every writable nested struct, so the pin flips to the round trip it used to
/// refuse, plus the refuse-before-attach guarantee at nesting depth.
///
/// <para><c>Faction.VendorLocation.Target</c> (<c>ALocationTarget</c>) as the subject: an abstract
/// union nested inside an ordinary struct column, whose <c>LocationFallback</c> leaf has no
/// <c>FormLink</c> members at all (<c>references/Mutagen/.../LocationTargetRadius.cs</c>), so this
/// fixture needs no supporting cast of linked records. The compile half of the acceptance criteria
/// lives in <see cref="AbstractUnionCompileRoundTripTests"/>.</para>
/// </summary>
public sealed class NestedStructSubFieldEditTests : IDisposable
{
    private readonly FactionFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>
    /// #642 pinned this exact payload shape as a whole-write refusal while nothing wrote nested
    /// structs; #643 makes it the round trip. Strictly stronger than the refusal it replaces: the
    /// nested value itself (<c>data: 3</c>) is asserted in the written document beside its writable
    /// sibling (<c>radius: 99</c>) — never just <c>Applied == true</c>, which is exactly the
    /// vacuity that let the original <c>Aliases_…RoundTrips</c> fact sit green while
    /// <c>location</c> was discarded.
    ///
    /// <para>Note the tracked seed's own <c>Target</c> is a <c>LocationTarget</c>, not the
    /// <c>LocationFallback</c> the fixture constructs: Track serializes from the *loaded binary*,
    /// and PLVD's binary discriminator is the Type value, so the seeded
    /// <c>LocationFallback{NearReference}</c> reparses as <c>LocationTarget</c> on the way in
    /// (Mutagen's own <c>GetLocationTarget</c>). This write therefore also switches the concrete
    /// leaf; the same-type reuse path is
    /// <see cref="VendorLocationTarget_SecondEditSameLeaf_ReusesAndKeepsUnnamedMembers"/>.</para>
    /// </summary>
    [Fact]
    public void VendorLocationTarget_NamedInPayload_RoundTrips()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""
            {"radius": 99, "target": {"concrete_type": "LocationFallback", "type": "NearSelf", "data": 3}}
            """));

        Assert.True(result.Applied, result.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Radius\": 99", body, StringComparison.Ordinal);
        Assert.Contains("\"Data\": 3", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// <c>ApplyStructJson</c>'s same-concrete-type object reuse, at nesting depth: once the record's
    /// own <c>Target</c> is a <c>LocationFallback</c> (first edit), a second edit naming the same
    /// leaf but omitting <c>type</c> keeps the existing object's <c>NearSelf</c> — members absent
    /// from the payload retain their values, which is only true when the existing value object is
    /// reused rather than constructed fresh (a fresh <c>LocationFallback</c> would zero <c>Type</c>
    /// back to <c>NearReference = 0</c>).
    /// </summary>
    [Fact]
    public void VendorLocationTarget_SecondEditSameLeaf_ReusesAndKeepsUnnamedMembers()
    {
        var service = _fixture.Service();
        var first = service.EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""{"target": {"concrete_type": "LocationFallback", "type": "NearSelf", "data": 3}}"""));
        Assert.True(first.Applied, first.Message);

        var second = service.EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""{"target": {"concrete_type": "LocationFallback", "data": 5}}"""));

        Assert.True(second.Applied, second.Message);
        var body = _fixture.Body();
        Assert.Contains("\"Data\": 5", body, StringComparison.Ordinal);
        Assert.Contains("\"Type\": \"NearSelf\"", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// Refuse-before-attach through every level (#643 AC): one bad member anywhere in the nested
    /// tree (<c>data</c> is an int — a non-numeric string cannot convert) refuses the whole write
    /// and leaves the working tree untouched. The byte-identical file compare is the real
    /// guarantee — the record object <c>EditField</c> mutates is a per-call throwaway parse of the
    /// source file, so the file's bytes are the record's persistent state — and the read-back of
    /// the seed's own <c>Radius</c> alongside proves the writable sibling in the same payload
    /// didn't land either (the whole atomic struct write refused, not just the bad member).
    /// </summary>
    [Fact]
    public void VendorLocation_BadNestedMemberValue_RefusesWholeWriteAndLeavesWorkingTreeUntouched()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""
            {"radius": 99, "target": {"concrete_type": "LocationFallback", "type": "NearSelf", "data": "not-a-number"}}
            """));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Equal(before, _fixture.Body());
        Assert.Contains("\"Radius\": 1", _fixture.Body(), StringComparison.Ordinal);
    }

    /// <summary>
    /// A nested abstract union with an unresolvable discriminator refuses rather than guessing —
    /// the same contract the top-level struct column already keeps
    /// (<c>AbstractUnionEditTests.Level_MissingDiscriminator_IsRefusedAndWritesNothing</c>),
    /// extended one level down by the shared <c>ApplyStructJson</c>.
    /// </summary>
    [Fact]
    public void VendorLocationTarget_MissingDiscriminator_RefusesAndWritesNothing()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Faction.ToString(), "vendor_location",
            Json("""{"radius": 99, "target": {"type": "NearSelf", "data": 3}}"""));

        Assert.False(result.Applied);
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

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Faction.ToString(), Plugin)!.Body!;

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
