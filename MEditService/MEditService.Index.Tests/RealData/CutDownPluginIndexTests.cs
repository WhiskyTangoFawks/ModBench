using System.Text.Json;
using MEditService.Index;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.RealData;

/// <summary>Existence/count assertions on purpose: the curated slice is regenerable, so pinning
/// exact FormKeys would make it brittle. The script read is the exception, since "returns without
/// throwing" would be vacuous.</summary>
public sealed class CutDownPluginIndexTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    [Fact]
    public void Index_RealWorldspaceData_PopulatesCellLocations()
    {
        var reads = fixture.Reads;
        var worldspaces = reads.Search(new RecordQuery(RecordTypes: ["wrld"], Limit: 50)).Items;
        Assert.NotEmpty(worldspaces);

        var cells = worldspaces.SelectMany(w => reads.GetWorldspaceCells(CutDownPluginFixture.Plugin, w.FormKey)).ToList();
        var interior = reads.GetInteriorCells(CutDownPluginFixture.Plugin, 50, 0).Items;

        Assert.True(cells.Count + interior.Count > 0,
            "Expected the cut-down plugin to contain worldspace/interior cells.");
    }

    [Fact]
    public void Index_RealPlacements_PopulatesTheCellsReferences()
    {
        var reads = fixture.Reads;
        var placed = reads.GetInteriorCells(CutDownPluginFixture.Plugin, 200, 0).Items
            .Select(c => reads.GetCellReferences(CutDownPluginFixture.Plugin, c.FormKey))
            .Sum(r => r.Persistent.Count + r.Temporary.Count);

        Assert.True(placed > 0, "Expected the cut-down plugin to contain placed references (REFR/ACHR).");
    }

    // Deliberately concrete rather than a bare "the field is there": this NPC is known to carry two
    // scripts, so a weakened assertion would pass even if the read dropped every script but one.
    [Fact]
    public void Index_RealScripts_ReadTheAdapterOffTheDocument()
    {
        var document = fixture.Reads.GetDocument("2499C4:Fallout4.esm", CutDownPluginFixture.Plugin);

        Assert.NotNull(document);
        var adapter = Assert.Single(document.Fields, f => f.Metadata.Name == "VirtualMachineAdapter");
        var adapterValue = adapter.Value ?? throw new InvalidOperationException("Expected VirtualMachineAdapter field to carry a value.");
        using var value = JsonDocument.Parse(
            adapterValue is JsonElement json ? json.GetRawText() : (string)adapterValue);
        var scripts = value.RootElement.GetProperty("Scripts");
        Assert.Equal(2, scripts.GetArrayLength());
        Assert.Contains(scripts.EnumerateArray(), s => s.GetProperty("Name").GetString() == "RadroachLegendaryScript");
    }

    // Real records cross-reference other forms; breadth is asserted via the distinct record types
    // that produced references, so a reader that only walked one type would fail.
    [Fact]
    public void Index_RealRecords_PopulateFormReferencesAcrossMultipleTypes()
    {
        var reads = fixture.Reads;
        var referencingTypes = reads.GetDocuments(CutDownPluginFixture.Plugin)
            .Select(d => d.FormKey)
            .SelectMany(reads.GetReferencedBy)
            .Select(r => r.RecordType)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();

        Assert.True(referencingTypes >= 3, "Expected references from at least 3 record types in the cut-down plugin.");
    }
}
