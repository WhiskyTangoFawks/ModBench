using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentTokensTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void ADocumentsOwnFormKey_IsAtTheRoot_AndAnyOtherFormKeyMemberOutsideAnEmbedSlotIsNot()
    {
        var keys = DocumentTokens.FormKeysIn(
            Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A.esp", "Struct": { "FormKey": "000802:A.esp" } }"""), Release);

        Assert.Equal(
            [new DocumentFormKey("000800:A.esp", FormKeyPosition.Root), new DocumentFormKey("000802:A.esp", FormKeyPosition.Other)],
            keys);
    }

    [Fact]
    public void TheFormKeysOfTextCutOffMidDocument_AreThoseBeforeTheCut()
    {
        var keys = DocumentTokens.FormKeysIn(Bytes("""{ "FormKey": "000800:A.esp", "Race": "000801:A"""), Release);

        Assert.Equal(["000800:A.esp"], keys.Select(key => key.FormKey));
    }

    [Fact]
    public void TheEditorIdsOfADocument_AreTheRootsAndEachEmbeddedChilds()
    {
        var ids = DocumentTokens.EditorIdsIn(Bytes("""{ "EditorID": "Owner", "Temporary": [ { "EditorID": "Child" } ] }"""));

        Assert.Equal(["Owner", "Child"], ids);
    }

    [Fact]
    public void TheEditorIdsOfTextCutOffMidDocument_AreThoseBeforeTheCut()
    {
        Assert.Equal(["Owner"], DocumentTokens.EditorIdsIn(Bytes("""{ "EditorID": "Owner", "Name": "Cu""")));
    }

    [Fact]
    public void ADocumentsEditorId_IsTheRootsOwnAndNeverAChilds()
    {
        var read = DocumentTokens.EditorIdIn("""{ "Temporary": [ { "EditorID": "Child" } ], "EditorID": "Owner" }""");

        Assert.Equal("Owner", read.EditorId);
    }

    [Theory]
    [InlineData("""{ "Name": "x" }""")]
    [InlineData("""{ "EditorID": null }""")]
    [InlineData("""{ "EditorID": "Cut""")]
    [InlineData("[]")]
    public void ADocumentNamingNoEditorIdOrNoDocument_ReadsAsNone(string text)
    {
        var read = DocumentTokens.EditorIdIn(text);

        Assert.Null(read.WhyUnreadable);
        Assert.Null(read.EditorId);
    }

    [Fact]
    public void ANonStringEditorId_IsUnreadable_RatherThanNone()
    {
        Assert.Equal("'EditorID' is not a string", DocumentTokens.EditorIdIn("""{ "EditorID": 7 }""").WhyUnreadable);
    }

    [Theory]
    [InlineData("""{ "Type": "Npc", "Count": 3, "Nested": { "Other": "deep" } }""", "Type", "Npc")]
    [InlineData("""{ "Type": "Npc", "Count": 3, "Nested": { "Other": "deep" } }""", "Count", null)]
    [InlineData("""{ "Type": "Npc", "Count": 3, "Nested": { "Other": "deep" } }""", "Other", null)]
    [InlineData("""{ "Type": "Npc", "Count": 3, "Nested": { "Other": "deep" } }""", "Missing", null)]
    [InlineData("""["Type"]""", "Type", null)]
    [InlineData("""{ "Type": "Npc" """, "Type", null)]
    public void ARootMember_ReadsAsAString_OnlyWhereTheDocumentsRootHoldsAString(string text, string member, string? expected)
    {
        Assert.Equal(expected, DocumentTokens.RootStringIn(text, member));
    }

    [Fact]
    public void AnObject_IsADocument()
    {
        Assert.Null(DocumentTokens.WhyNotADocument("""{ "FormKey": "000800:A.esp" }"""));
    }

    [Theory]
    [InlineData("""["a"]""", "its root is not a JSON object.")]
    [InlineData("""{ "FormKey": "000800:A.esp", """, "LineNumber: 0 | BytePositionInLine: 29.")]
    [InlineData("""{ "FormKey": "000800:A.esp" } // a comment no document reader takes""", "LineNumber: 0 | BytePositionInLine: 30.")]
    public void TextThatIsNoObject_IsNoDocument_SayingWhereTheReaderStopped(string text, string why)
    {
        Assert.EndsWith(why, DocumentTokens.WhyNotADocument(text), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("""{ "FormKey": "000800:Some.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800:\u0053ome.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800_Some.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800:SOME.esp" }""", true)]
    [InlineData("""{ "FormKey": "000800:Other.esp" }""", false)]
    public void ADocument_MayCarryAFormKey_UnlessItsBytesCertainlyDoNotSpellIt(string text, bool expected)
    {
        Assert.Equal(expected, DocumentTokens.MayCarry(Bytes(text), Bytes("000800:Some.esp")));
    }

    [Fact]
    public void APluginNameBeyondAscii_IsMatchedWithoutCase()
    {
        Assert.True(DocumentTokens.MayCarry(Bytes("""{ "FormKey": "000800:ÜNI.ESP" }"""), Bytes("000800:Üni.esp")));
        Assert.False(DocumentTokens.MayCarry(Bytes("""{ "FormKey": "000800:Other.esp" }"""), Bytes("000800:Üni.esp")));
    }
}
