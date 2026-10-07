using System.Text.Json;
using MEditService.Index.Tests.TestSupport;

namespace MEditService.Index.Tests.RealData;

[Collection(CutDownPluginCollection.Name)]
public sealed class CutDownPluginIndexTests(CutDownPluginFixture fixture)
{
    [Fact]
    public void RealScripts_ReadTheAdapterOffTheDocument()
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

    [Fact]
    public void RealRecords_PopulateFormReferencesAcrossMultipleTypes()
    {
        var referencingTypes = IndexFiles.Rows(fixture.InstanceRoot, "SELECT DISTINCT record_type FROM form_references");

        Assert.True(referencingTypes.Count >= 3, "Expected references from at least 3 record types in the cut-down plugin.");
    }
}
