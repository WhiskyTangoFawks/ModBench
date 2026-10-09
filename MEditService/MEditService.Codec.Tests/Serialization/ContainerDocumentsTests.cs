using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ContainerDocumentsTests
{
    private static readonly ContainerDocuments Documents = new(GameRelease.Fallout4);

    private const string Worldspace = """
        {
          "FormKey": "000800:A.esp",
          "TopCell": {
            "FormKey": "000801:A.esp",
            "Temporary": [
              { "FormKey": "000802:A.esp", "MutagenObjectType": "PlacedNpc" },
              { "FormKey": "000803:A.esp", "MutagenObjectType": "PlacedObject" }
            ]
          }
        }
        """;

    [Fact]
    public void EmbeddedChild_APlacedReferenceInAWorldspacesTopCell_IsFoundAtItsPlaceInTheList_TypedAsItsTextSpellsIt()
    {
        var child = Documents.EmbeddedChild("wrld", Encoding.UTF8.GetBytes(Worldspace), "000803:A.esp");

        Assert.Equal(("Temporary", 1, "refr"), (child?.SlotName, child?.SlotIndex, child?.RecordType));
    }

    [Fact]
    public void ContainmentOf_APlacedReferenceInAWorldspacesTopCell_IsTheTopCellsTemporarySlot()
    {
        using var document = JsonDocument.Parse(Worldspace);

        Assert.Equal(
            new DocumentContainment("000801:A.esp", "cell", "Temporary"),
            Documents.ContainmentOf("wrld", document.RootElement, "000803:A.esp"));
    }
}
