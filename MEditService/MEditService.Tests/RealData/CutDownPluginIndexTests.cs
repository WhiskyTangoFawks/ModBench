using System.Globalization;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// Indexing assertions against the committed cut-down real-data plugin. These verify the
/// pipeline survives authentic Bethesda records (real VMAD shapes, real worldspace/cell trees,
/// real placements) — hermetic, with no 316 MB master, and fast enough to stay in the mutation
/// suite.
///
/// Assertions are existence/count based on purpose: the curated slice is regenerable, so pinning
/// exact FormKeys would make it brittle. Per-field correctness lives in the synthetic
/// <c>PlacementIndexingTests</c> / <c>GetVmadTests</c>. <c>Index_RealScripts_ReconstitutesVmadFromDocument</c>
/// is the deliberate exception: a bare "returns without throwing" check
/// would be vacuous, so it pins one known real record
/// instead — same regeneration risk RealDataReadGoldenTests' goldens already accept.
/// </summary>
public sealed class CutDownPluginIndexTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture = fixture;

    private long Count(string table)
    {
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM {table}";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    [Fact]
    public void Index_RealWorldspaceData_PopulatesCellLocations()
    {
        Assert.True(Count("cell_location") > 0,
            "Expected the cut-down plugin to contain worldspace/interior cells.");
    }

    [Fact]
    public void Index_RealPlacements_PopulatesPlacementTable()
    {
        Assert.True(Count("placement") > 0,
            "Expected the cut-down plugin to contain placed references (REFR/ACHR).");
    }

    // VMAD reconstitutes from the record's own document (there is no vmad_scripts table), so this
    // goes through GetVmad instead of a table count. Deliberately still concrete rather than a bare
    // "GetVmad doesn't throw" check: FormKey 2499C4:Fallout4.esm is a real NPC in the curated slice
    // known to carry two scripts, one named RadroachLegendaryScript (pinned in the realdata-vmad.json
    // golden too) — a weakened "returns non-null somewhere" assertion would pass even if GetVmad
    // silently dropped every script but one.
    [Fact]
    public void Index_RealScripts_ReconstitutesVmadFromDocument()
    {
        var document = _fixture.Repo.GetDocument("2499C4:Fallout4.esm", new PluginKey(CutDownPluginFixture.PluginFileName, "Data"));
        var vmad = document == null ? null : RecordDocumentCodecs.GetVmad(document, GameRelease.Fallout4, NullLogger.Instance);

        Assert.NotNull(vmad);
        Assert.Equal(2, vmad.Scripts.Count);
        Assert.Contains(vmad.Scripts, s => s.Name == "RadroachLegendaryScript");
    }

    [Fact]
    public void Index_RealRecords_PopulateFormReferencesAcrossMultipleTypes()
    {
        // Real records cross-reference other forms; this exercises form-reference indexing and
        // SchemaReflector's per-type extraction on authentic field data. Breadth is asserted via
        // the distinct record types that produced references.
        using var cmd = _fixture.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(DISTINCT record_type) FROM form_references";
        Assert.True(Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) >= 3,
            "Expected references from at least 3 record types in the cut-down plugin.");
    }
}
