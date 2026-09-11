using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>A member the union's leaves shape differently is written through the leaf the
/// document names, a record-level scalar and an OMOD property value alike; the result is the
/// codec's own document (ADR-0005).</summary>
public sealed class UnionVariantEditTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static readonly FormKey Key = FormKey.Factory("000801:UnionVariant.esp");

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void GameSettingFloat_Data_IsWrittenAsTheFloatItsLeafDeclares()
    {
        var before = DocumentEdits.Serialize(new GameSettingFloat(Key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 1.5f });

        var refusal = DocumentEdits.Apply(before, Schemas["gmst"], SetAt(Json("2.5"), Member("Data")), out var written);

        Assert.Null(refusal);
        Assert.Equal(
            DocumentEdits.Serialize(new GameSettingFloat(Key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 2.5f }),
            written);
    }

    [Fact]
    public void GameSettingBool_Data_RefusesAFloat_BecauseItsOwnLeafHoldsABool()
    {
        var before = DocumentEdits.Serialize(new GameSettingBool(Key, Fallout4Release.Fallout4) { EditorID = "bTest", Data = true });

        var refusal = DocumentEdits.Apply(before, Schemas["gmst"], SetAt(Json("2.5"), Member("Data")), out _);

        Assert.NotNull(refusal);
        Assert.Equal(RecordEditRefusal.CodecRejected, refusal.Refusal);
        Assert.Contains("Data", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ObjectModIntProperty_Value_IsWrittenAsTheIntItsLeafDeclares()
    {
        var before = DocumentEdits.Serialize(ArmorMod(value: 5));

        var refusal = DocumentEdits.Apply(
            before, Schemas["omod"], SetAt(Json("42"), Member("Properties"), At(0), Member("Value")), out var written);

        Assert.Null(refusal);
        Assert.Equal(DocumentEdits.Serialize(ArmorMod(value: 42)), written);
    }

    private static ArmorModification ArmorMod(uint value)
    {
        var armor = new ArmorModification(Key, Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f, Value = value });
        return armor;
    }
}
