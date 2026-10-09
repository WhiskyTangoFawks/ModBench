using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentTokensTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void FormKeysIn_ADocumentsOwnKey_IsAtTheRoot_AndALinkIsNeitherAtTheRootNorEmbedded()
    {
        var keys = DocumentTokens.FormKeysIn(
            Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A.esp" }"""), Release);

        Assert.Equal([new DocumentFormKey("000800:A.esp", AtRoot: true, InAnEmbedSlot: false)], keys);
    }

    [Fact]
    public void FormKeysIn_AChildInTheSlotAContainerEmbedsItIn_IsEmbedded_AtAnyDepth()
    {
        var keys = DocumentTokens.FormKeysIn(
            Bytes("""
                {
                  "FormKey": "000800:A.esp",
                  "TopCell": {
                    "FormKey": "000801:A.esp",
                    "Temporary": [ { "FormKey": "000802:A.esp", "Base": "000803:A.esp" } ]
                  }
                }
                """), Release);

        Assert.Equal(
            ["000801:A.esp", "000802:A.esp"],
            keys.Where(key => key.InAnEmbedSlot).Select(key => key.FormKey));
        Assert.Equal(["000800:A.esp"], keys.Where(key => key.AtRoot).Select(key => key.FormKey));
    }

    [Fact]
    public void FormKeysIn_TextCutOffMidDocument_YieldsWhatItReadBeforeTheCut()
    {
        var keys = DocumentTokens.FormKeysIn(Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A"""), Release);

        Assert.Equal(["000800:A.esp"], keys.Select(key => key.FormKey));
    }

    [Fact]
    public void EditorIdsIn_ReadsTheRootsAndAnEmbeddedChilds_AndAnswersNullForOneThatIsNoString()
    {
        var ids = DocumentTokens.EditorIdsIn(
            Bytes("""{ "EditorID": "Owner", "Temporary": [ { "EditorID": "Child" }, { "EditorID": 7 }, { "EditorID": null } ] }"""));

        Assert.Equal(["Owner", "Child", null], ids);
    }

    [Fact]
    public void EditorIdsIn_TextCutOffMidDocument_YieldsWhatItReadBeforeTheCut()
    {
        Assert.Equal(["Owner"], DocumentTokens.EditorIdsIn(Bytes("""{ "EditorID": "Owner", "Name": "Cu""")));
    }
}
