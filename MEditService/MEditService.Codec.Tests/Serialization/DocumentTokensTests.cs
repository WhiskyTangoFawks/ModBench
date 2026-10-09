using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentTokensTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void FormKeysIn_ADocumentsOwnKey_IsAtTheRoot_AndAnyOtherFormKeyMemberOutsideAnEmbedSlotIsNot()
    {
        var keys = DocumentTokens.FormKeysIn(
            Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A.esp", "Struct": { "FormKey": "000802:A.esp" } }"""), Release);

        Assert.Equal(
            [new DocumentFormKey("000800:A.esp", FormKeyPosition.Root), new DocumentFormKey("000802:A.esp", FormKeyPosition.Other)],
            keys);
    }

    [Fact]
    public void FormKeysIn_TextCutOffMidDocument_YieldsWhatItReadBeforeTheCut()
    {
        var keys = DocumentTokens.FormKeysIn(Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A"""), Release);

        Assert.Equal(["000800:A.esp"], keys.Select(key => key.FormKey));
    }

    [Fact]
    public void EditorIdsIn_ReadsTheRootsAndAnEmbeddedChilds()
    {
        var ids = DocumentTokens.EditorIdsIn(Bytes("""{ "EditorID": "Owner", "Temporary": [ { "EditorID": "Child" } ] }"""));

        Assert.Equal(["Owner", "Child"], ids);
    }

    [Fact]
    public void EditorIdsIn_TextCutOffMidDocument_YieldsWhatItReadBeforeTheCut()
    {
        Assert.Equal(["Owner"], DocumentTokens.EditorIdsIn(Bytes("""{ "EditorID": "Owner", "Name": "Cu""")));
    }

    [Fact]
    public void RootStringIn_AnswersAStringMemberOfTheRootOnly()
    {
        const string Text = """{ "Type": "Npc", "Count": 3, "Nested": { "Other": "deep" } }""";

        Assert.Equal("Npc", DocumentTokens.RootStringIn(Text, "Type"));
        Assert.Null(DocumentTokens.RootStringIn(Text, "Count"));
        Assert.Null(DocumentTokens.RootStringIn(Text, "Other"));
        Assert.Null(DocumentTokens.RootStringIn(Text, "Missing"));
    }

    [Theory]
    [InlineData("""["Type"]""")]
    [InlineData("""{ "Type": "Npc" """)]
    public void RootStringIn_OfTextThatIsNoObjectDocument_AnswersNull(string text)
    {
        Assert.Null(DocumentTokens.RootStringIn(text, "Type"));
    }

    [Fact]
    public void WhyNotADocument_OfAnObject_IsNull()
    {
        Assert.Null(DocumentTokens.WhyNotADocument("""{ "FormKey": "000800:A.esp" }"""));
    }

    [Theory]
    [InlineData("""["a"]""")]
    [InlineData("""{ "FormKey": "000800:A.esp", """)]
    [InlineData("""{ "FormKey": "000800:A.esp" } // a comment no document reader takes""")]
    public void WhyNotADocument_OfTextThatIsNoObject_SaysWhy(string text)
    {
        Assert.False(string.IsNullOrEmpty(DocumentTokens.WhyNotADocument(text)));
    }

    [Theory]
    [InlineData("""{ "FormKey": "000800:Some.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800:\u0053ome.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800:Other.esp" }""", false)]
    public void MayCarry_IsFalseOnlyWhenTheBytesCertainlyDoNotSpellTheFormKey(string text, bool expected)
    {
        Assert.Equal(expected, DocumentTokens.MayCarry(Bytes(text), Bytes("000800:Some.esp")));
    }
}
