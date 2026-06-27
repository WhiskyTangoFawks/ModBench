using System.Globalization;
using MEditService.Core.Records;

namespace MEditService.Tests.RealData;

/// <summary>
/// Indexing assertions against the committed cut-down real-data plugin. These verify the
/// pipeline survives authentic Bethesda records (real VMAD shapes, real worldspace/cell trees,
/// real placements) — the coverage the old 316 MB <c>RealGameLoadTests</c> provided, now
/// hermetic and fast enough to stay in the mutation suite.
///
/// Assertions are existence/count based on purpose: the curated slice is regenerable, so pinning
/// exact FormKeys would make it brittle. Per-field correctness lives in the synthetic
/// <c>PlacementIndexingTests</c> / <c>GetVmadTests</c>.
/// </summary>
public sealed class CutDownPluginIndexTests : IClassFixture<CutDownPluginFixture>
{
    private readonly CutDownPluginFixture _fixture;

    public CutDownPluginIndexTests(CutDownPluginFixture fixture) => _fixture = fixture;

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

    [Fact]
    public void Index_RealScripts_PopulatesVmadTables()
    {
        Assert.True(Count("vmad_scripts") > 0,
            "Expected the cut-down plugin to contain at least one VMAD-scripted record.");
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
