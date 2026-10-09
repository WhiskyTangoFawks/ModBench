using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class UnionVariantEditTests : IDisposable
{
    private readonly DocumentEditFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private static readonly FormKey Key = FormKey.Factory("000801:DocEdit.esp");

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void GameSettingBool_Data_RefusesAFloat_BecauseItsOwnLeafHoldsABool()
    {
        var formKey = _fixture.Seed(new GameSettingBool(Key, Fallout4Release.Fallout4) { EditorID = "bTest", Data = true }, "gmst");

        var (result, _) = _fixture.Apply(formKey, SetAt(Json("2.5"), Member("Data")));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CodecRejected, result.Refusal);
        Assert.Contains("Data", result.Message, StringComparison.Ordinal);
    }
}
