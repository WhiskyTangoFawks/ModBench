using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

/// <summary>An array op reconstructs the whole list from the column's own extracted value, so any
/// member the schema does not carry is silently dropped from every element the op rewrites.</summary>
public sealed class ByteSliceArrayOpEditTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private EditRecordHandler Service() => _mod.EditHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private const string DebrisEditorId = "FixtureDebris";

    // The two blobs are deliberately different lengths: a nested length gate reading the pre-write
    // element at its own index would refuse the reorder below, since an array op rewrites the whole
    // list.
    private static readonly string[] TwoModels =
    [
        """{"Percentage": 50, "ModelFilename": "First.nif", "TextureFileHashes": "0x1122"}""",
        """{"Percentage": 50, "ModelFilename": "Second.nif", "TextureFileHashes": "0xAABBCCDD"}""",
    ];

    private string SeedDebrisWithTwoModelsCarryingBlobs()
    {
        var created = _mod.CreateHandler.CreateRecord(_mod.Plugin, "debr", DebrisEditorId);
        Assert.True(created.Applied, created.Message);

        var seed = Service().Set(_mod.Plugin, created.NewFormKey.Require(), "Models",
            Json("[" + string.Join(",", TwoModels) + "]"));
        Assert.True(seed.Applied, seed.Message);
        return created.NewFormKey.Require();
    }

    private string DebrisBody(string formKey) => _mod.Document(formKey).Require().Body;

    [Fact]
    public void ArrayRemove_OnAListWhoseElementsCarryAByteSlice_LeavesTheSurvivorsBlobUntouched()
    {
        var debris = SeedDebrisWithTwoModelsCarryingBlobs();
        Assert.Contains("0xAABBCCDD", DebrisBody(debris), StringComparison.Ordinal);

        var result = Service().Edit(_mod.Plugin, debris, RemoveAt(Member("Models"), At(0)));

        Assert.True(result.Applied, result.Message);
        var body = DebrisBody(debris);
        Assert.DoesNotContain("0x1122", body, StringComparison.Ordinal);
        Assert.Contains("0xAABBCCDD", body, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayMoveUp_OnAListWhoseElementsCarryAByteSlice_KeepsBothBlobs()
    {
        var debris = SeedDebrisWithTwoModelsCarryingBlobs();

        var result = Service().Edit(_mod.Plugin, debris, MoveTo(0, Member("Models"), At(1)));

        Assert.True(result.Applied, result.Message);
        var body = DebrisBody(debris);
        Assert.Contains("0x1122", body, StringComparison.Ordinal);
        Assert.Contains("0xAABBCCDD", body, StringComparison.Ordinal);
    }
}
