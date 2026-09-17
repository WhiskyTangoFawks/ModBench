using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using static MEditService.Tests.TestSupport.Envelopes;

namespace MEditService.Tests.Edits;

/// <summary>A member the union's leaves shape differently is written through the leaf the
/// document names, a record-level scalar and an OMOD property value alike; the result is the
/// codec's own document (ADR-0005).</summary>
public sealed class UnionVariantEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    public void Dispose() => _fixture.Dispose();

    private static readonly FormKey Key = FormKey.Factory("000801:DocEdit.esp");

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static string Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetString(Codec.SerializeToBytes(record, GameRelease.Fallout4));

    [Fact]
    public void GameSettingFloat_Data_IsWrittenAsTheFloatItsLeafDeclares()
    {
        var formKey = _fixture.Seed(new GameSettingFloat(Key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 1.5f }, "gmst");

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("2.5"), Member("Data")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(Serialize(new GameSettingFloat(Key, Fallout4Release.Fallout4) { EditorID = "fTest", Data = 2.5f }), after);
    }

    [Fact]
    public void GameSettingBool_Data_RefusesAFloat_BecauseItsOwnLeafHoldsABool()
    {
        var formKey = _fixture.Seed(new GameSettingBool(Key, Fallout4Release.Fallout4) { EditorID = "bTest", Data = true }, "gmst");

        var (result, _) = _fixture.Apply(formKey, SetAt(Json("2.5"), Member("Data")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Data", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ObjectModIntProperty_Value_IsWrittenAsTheIntItsLeafDeclares()
    {
        var formKey = _fixture.Seed(ArmorMod(value: 5), "omod");

        var (result, after) = _fixture.Apply(formKey, SetAt(Json("42"), Member("Properties"), At(0), Member("Value")));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(Serialize(ArmorMod(value: 42)), after);
    }

    private static ArmorModification ArmorMod(uint value)
    {
        var armor = new ArmorModification(Key, Fallout4Release.Fallout4) { EditorID = "ArmorMod" };
        armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f, Value = value });
        return armor;
    }
}
