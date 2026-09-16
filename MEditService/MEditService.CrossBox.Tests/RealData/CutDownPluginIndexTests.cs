using System.Globalization;
using System.Text.Json;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>Existence/count assertions on purpose: the curated slice is regenerable, so pinning
/// exact FormKeys would make it brittle. <c>Index_RealScripts_ReconstitutesVmadFromDocument</c> is
/// the exception, since "returns without throwing" would be vacuous.</summary>
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

    // Deliberately concrete rather than a bare "the field is there": this NPC is known to carry two
    // scripts, so a weakened assertion would pass even if the read dropped every script but one.
    [Fact]
    public void Index_RealScripts_ReadTheAdapterOffTheDocument()
    {
        var document = _fixture.Repo.At(RecordRef.Effective).GetDocument("2499C4:Fallout4.esm", new PluginCopyKey(CutDownPluginFixture.PluginFileName, "Data"));

        Assert.NotNull(document);
        var adapter = Assert.Single(document!.Fields, f => f.Metadata.Name == "VirtualMachineAdapter");
        using var value = JsonDocument.Parse(
            adapter.Value is JsonElement json ? json.GetRawText() : (string)adapter.Value!);
        var scripts = value.RootElement.GetProperty("Scripts");
        Assert.Equal(2, scripts.GetArrayLength());
        Assert.Contains(scripts.EnumerateArray(), s => s.GetProperty("Name").GetString() == "RadroachLegendaryScript");
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
