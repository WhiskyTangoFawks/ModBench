using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class DocumentNamesTests
{
    private const string Npc = "000801:Mod.esp";
    private const string Texture = "000802:Mod.esp";
    private const string Child = "000803:Mod.esp";

    private static readonly Dictionary<string, string> TypeOf = new() { [Npc] = "npc_", [Texture] = "txst", [Child] = "npc_" };

    private static IReadOnlyList<ColumnSpec>? ColumnsOf(string formKey) =>
        TypeOf.TryGetValue(formKey, out var type) ? SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[type].RecordColumns : null;

    private static List<(DocumentNameKind Kind, string Spanned, string Value, string? Record, string? FieldPath)> Named(
        string text, int? at = null, Func<string, IReadOnlyList<ColumnSpec>?>? columnsOf = null) =>
        [.. DocumentNames.In(DocumentSpans.Read(text), columnsOf ?? ColumnsOf, at)
            .Select(name => (name.Kind, text[name.Start..name.End], name.Value, name.Record, name.FieldPath))];

    private static string NpcText(string members) => $$"""{ "FormKey": "{{Npc}}", {{members}} }""";

    private static string Scripted(string script) =>
        NpcText($$"""
            "VirtualMachineAdapter": { "Scripts": [ { "Name": "{{script}}", "Properties": [ { "Name": "Count" } ] } ] }
            """);

    [Fact]
    public void ARecordsFormKeys_NameItsRecordAndThePluginInside_AndItsEditorIdIsItsOwn()
    {
        Assert.Equal(
            [
                (DocumentNameKind.Declaration, $"\"FormKey\": \"{Npc}\"", Npc, Npc, "FormKey"),
                (DocumentNameKind.Record, $"\"{Npc}\"", Npc, Npc, "FormKey"),
                (DocumentNameKind.Plugin, "Mod.esp", "Mod.esp", Npc, "FormKey"),
                (DocumentNameKind.EditorId, "Holder", "Holder", Npc, "EditorID"),
                (DocumentNameKind.Record, "\"00080a_Base.esm\"", "00080A:Base.esm", Npc, "Race"),
                (DocumentNameKind.Reference, "00080a_Base.esm", "00080a_Base.esm", Npc, "Race"),
                (DocumentNameKind.Plugin, "Base.esm", "Base.esm", Npc, "Race"),
            ],
            Named(NpcText("""
                "EditorID": "Holder", "Race": "00080a_Base.esm"
                """)));
    }

    [Theory]
    [InlineData("Null")]
    [InlineData("null")]
    [InlineData(" Null ")]
    public void AnUnsetLink_NamesNoRecord_OnlyTheTextOfItsField(string unset)
    {
        Assert.Equal(
            [(DocumentNameKind.Reference, unset, unset, Npc, "Race")],
            Named(NpcText($$"""
                "Race": "{{unset}}"
                """)).Where(name => name.FieldPath == "Race"));
    }

    [Fact]
    public void AFormKeySpelledWithSpaceAroundIt_NamesItsPluginWhereTheTextSpellsIt()
    {
        var text = NpcText("""
            "Race": " 000802:Base.esm "
            """);

        Assert.Contains((DocumentNameKind.Plugin, "Base.esm", "Base.esm", Npc, "Race"), Named(text));
    }

    [Fact]
    public void AnEditorIdThatLooksLikeAFormKey_NamesNoRecord()
    {
        Assert.DoesNotContain(Named(NpcText("""
            "EditorID": "ABCDEF_Foo"
            """)), name => name.Value == "ABCDEF_Foo" && name.Kind != DocumentNameKind.EditorId);
    }

    [Fact]
    public void AFormKeySpelledAsAMembersName_NamesNoRecord()
    {
        Assert.DoesNotContain(Named(NpcText($$"""
            "{{Child}}": 1
            """)), name => name.Value == Child);
    }

    [Fact]
    public void AScriptARecordAttaches_IsNamedBetweenItsQuotes_AndAPropertyIsNot()
    {
        Assert.Equal(
            [(DocumentNameKind.Script, "Ns:Quest", "Ns:Quest", Npc, "VirtualMachineAdapter.Scripts[0].Name")],
            Named(Scripted("Ns:Quest")).Where(name => name.Kind == DocumentNameKind.Script));
    }

    [Fact]
    public void AFormKeyWhereAScriptIsNamed_NamesARecordAndNoScript()
    {
        Assert.DoesNotContain(Named(Scripted(Child)), name => name.Kind == DocumentNameKind.Script);
    }

    [Theory]
    [InlineData(@"Decals\\Stain_d.dds", "Textures/Decals/Stain_d.dds", "")]
    [InlineData("Data/Stain_d.dds", null, "Path Stain_d.dds did not start with expected Asset")]
    public void APathARecordHolds_NamesTheFileItsAssetTypePlaces_OrSaysWhyItCannot(string given, string? dataPath, string refusal)
    {
        var text = $$"""{ "FormKey": "{{Texture}}", "Diffuse": "{{given}}" }""";

        var file = Assert.Single(DocumentNames.In(DocumentSpans.Read(text), ColumnsOf, null), name => name.Kind == DocumentNameKind.File);

        Assert.Equal((given, dataPath, refusal), (text[file.Start..file.End], file.DataPath, file.Refusal?[..refusal.Length] ?? ""));
    }

    [Theory]
    [InlineData("an unclosed string at the end", """{ "FormKey": "000801:Mod.esp", "Race": "Hu""")]
    [InlineData("an unclosed string at a line break", "{ \"FormKey\": \"000801:Mod.esp\", \"Race\": \"Hu\n}")]
    [InlineData("a member with no comma before it", """{ "FormKey": "000801:Mod.esp" "Race": "Hu" }""")]
    [InlineData("a trailing comma", """{ "FormKey": "000801:Mod.esp", "Race": "Hu", }""")]
    [InlineData("comments", "{ // the record\n \"FormKey\": \"000801:Mod.esp\", /* a link */ \"Race\": \"Hu\" }")]
    [InlineData("an object never closed", """{ "FormKey": "000801:Mod.esp", "Race": "Hu" """)]
    public void AReferenceBeingTyped_IsNamed_WithTheTypesItsFieldAllows_InTextThatIs(string _, string text)
    {
        var reference = Assert.Single(DocumentNames.In(DocumentSpans.Read(text), ColumnsOf, null), name => name.Kind == DocumentNameKind.Reference);

        Assert.Equal(("Hu", "Race", "race"), (text[reference.Start..reference.End], reference.FieldPath, string.Join(",", reference.ValidFormKeyTypes ?? [])));
    }

    [Fact]
    public void ANameIsItsValue_PastItsEscapes_AtItsSpanInTheText_PastAnyCharacterBeyondAscii()
    {
        var text = NpcText("""
            "FULL": "Épée 🗡", "EditorID": "Rusty\"Gun"
            """);

        var editorId = Assert.Single(DocumentNames.In(DocumentSpans.Read(text), ColumnsOf, null), name => name.Kind == DocumentNameKind.EditorId);

        Assert.Equal(("Rusty\"Gun", "Rusty\\\"Gun"), (editorId.Value, text[editorId.Start..editorId.End]));
    }

    [Fact]
    public void AChildRecordsNames_AreItsOwn()
    {
        const string cell = "000804:Mod.esp";
        var text = $$"""{ "FormKey": "{{cell}}", "Temporary": [ { "MutagenObjectType": "PlacedObject", "FormKey": "{{Child}}", "Base": "Hu" } ] }""";
        var types = new Dictionary<string, string> { [cell] = "cell", [Child] = "refr" };
        IReadOnlyList<ColumnSpec>? columnsOf(string formKey) =>
            types.TryGetValue(formKey, out var type) ? SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[type].RecordColumns : null;

        Assert.Equal(
            [(DocumentNameKind.Reference, "Hu", "Hu", Child, "Base")],
            Named(text, columnsOf: columnsOf).Where(name => name.Kind == DocumentNameKind.Reference));
    }

    [Fact]
    public void ARecordNoSchemaAnswersFor_HoldsOnlyItsFormKeysAndEditorId()
    {
        Assert.Equal(
            [DocumentNameKind.Declaration, DocumentNameKind.Record, DocumentNameKind.Plugin],
            Named(Scripted("Ns:Quest"), columnsOf: _ => null).Select(name => name.Kind));
    }

    [Theory]
    [InlineData("Base.esm\"", new[] { DocumentNameKind.Record, DocumentNameKind.Reference, DocumentNameKind.Plugin })]
    [InlineData("00080a", new[] { DocumentNameKind.Record, DocumentNameKind.Reference })]
    [InlineData("\"FormKey\"", new[] { DocumentNameKind.Declaration })]
    [InlineData("\"Race\"", new DocumentNameKind[0])]
    public void TheNamesAtAnOffset_AreEachThatSitsThere(string at, DocumentNameKind[] kinds)
    {
        var text = NpcText("""
            "Race": "00080a_Base.esm"
            """);

        Assert.Equal(kinds, Named(text, text.IndexOf(at, StringComparison.Ordinal) + 1).Select(name => name.Kind));
    }
}
