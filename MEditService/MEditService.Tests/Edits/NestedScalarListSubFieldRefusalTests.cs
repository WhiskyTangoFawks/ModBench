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
/// #643's survey found a second silently-discarded family beside nested Loqui structs: a
/// primitive-element list nested inside a struct/array column
/// (<c>SchemaReflector.BuildListSubField</c> wires an apply only for FormLink/Loqui/vector
/// elements, so e.g. <c>Race.Subgraphs[].AnimationPaths</c> — a list of strings one level inside an
/// array element — carried <c>Apply: null</c> with <c>TargetingRefuses</c> still false, and a
/// payload naming it reported success while the value was discarded). #642's own contract — a
/// genuinely unwritable named sub-field takes an honest refusal, never silent success — extends to
/// them here.
///
/// <para>Refusal, not writability, deliberately (maintainer decision at #643's gate): a top-level
/// primitive-element list column's own null <c>Apply</c> already refuses as <c>FieldReadOnly</c>,
/// so refusing the nested shape is parity with its own top level; making both writable end-to-end
/// is a separate capability, noted for the maintainer rather than built here.</para>
/// </summary>
public sealed class NestedScalarListSubFieldRefusalTests : IDisposable
{
    private readonly RaceFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    /// <summary>
    /// Naming the scalar-element list refuses the whole write and leaves the working tree
    /// untouched — including the writable sibling in the same payload, since a complex field's
    /// write is atomic. Before #643 this exact edit answered <c>Applied == true</c> while
    /// <c>animation_paths</c> silently vanished.
    /// </summary>
    [Fact]
    public void Subgraphs_ElementNamingAnimationPaths_RefusesTheWholeWrite()
    {
        var before = _fixture.Body();

        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), "subgraphs",
            Json("""[{"role": "Weapon", "animation_paths": ["Actors\\Shared"]}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NestedFieldReadOnly, result.Refusal);
        Assert.Contains("subgraphs", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, _fixture.Body());
    }

    /// <summary>Absence is not targeting: the same element write with the unwritable list simply
    /// omitted still applies, exactly as every other sub-field refusal already behaves
    /// (<c>NestedStructSubFieldEditTests.VendorLocation_PayloadOmittingTarget_…</c>).</summary>
    [Fact]
    public void Subgraphs_ElementOmittingAnimationPaths_StillApplies()
    {
        var result = _fixture.Service().EditField(_fixture.Plugin, _fixture.Race.ToString(), "subgraphs",
            Json("""[{"role": "Weapon"}]"""));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"Role\": \"Weapon\"", _fixture.Body(), StringComparison.Ordinal);
    }

    /// <summary>One real mod folder holding one <c>Race</c> with one <c>Subgraph</c>, tracked once —
    /// the established self-contained-fixture-per-file convention
    /// (<c>ScalarFieldApplierRefusalTests</c>' own stated reasoning). <c>Race.Subgraphs</c> is the
    /// one nested scalar-element list in the survey's set that is reachable through
    /// <c>EditField</c> on an ordinary record with a small fixture (the cell/worldspace/scene paths
    /// sit behind the containment-field refusal, and PACK/NOCM need far heavier records).</summary>
    private sealed class RaceFixture : IDisposable
    {
        private const string PluginName = "Race643.esp";
        private const string Origin = "Race643Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-643-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-643-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey Race { get; }

        public RaceFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

            var race = mod.Races.AddNew("Race643");
            race.Subgraphs.Add(new Subgraph { Role = Subgraph.SubgraphRole.MT });
            Race = race.FormKey;

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

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(Race.ToString(), Plugin)!.Body!;

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
