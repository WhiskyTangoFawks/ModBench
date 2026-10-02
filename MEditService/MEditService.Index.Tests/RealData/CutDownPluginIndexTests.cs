using System.Text.Json;
using MEditService.Index.Tests.TestSupport;

namespace MEditService.Index.Tests.RealData;

/// <summary>Existence/count assertions on purpose: the curated slice is regenerable, so pinning
/// exact FormKeys would make it brittle. The script read is the exception, since "returns without
/// throwing" would be vacuous.</summary>
[Collection(CutDownPluginCollection.Name)]
public sealed class CutDownPluginIndexTests(CutDownPluginFixture fixture)
{
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
        var referencingTypes = IndexFiles.Rows(fixture.InstanceRoot, "SELECT DISTINCT record_type FROM form_references");

        Assert.True(referencingTypes.Count >= 3, "Expected references from at least 3 record types in the cut-down plugin.");
    }
}
