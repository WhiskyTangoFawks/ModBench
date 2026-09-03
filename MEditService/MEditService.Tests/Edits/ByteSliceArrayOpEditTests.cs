using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #690 AC #2. An array op reconstructs the whole list from the column's own extracted value
/// (<c>ArrayOpWriter</c>), so any member the schema does not carry is silently dropped from every
/// element the op rewrites. A byte-slice member is carried, so removing one element leaves its
/// siblings' blobs byte-identical rather than reset to nothing.
/// </summary>
public sealed class ByteSliceArrayOpEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private const string DebrisEditorId = "FixtureDebris";

    // The two blobs are deliberately different lengths: a nested length gate reading the pre-write
    // element at its own index would refuse the reorder below, since an array op rewrites the whole
    // list and index i afterwards holds a different element than it did before.
    private static readonly string[] TwoModels =
    [
        """{"percentage": 50, "model_filename": "First.nif", "texture_file_hashes": "0x1122"}""",
        """{"percentage": 50, "model_filename": "Second.nif", "texture_file_hashes": "0xAABBCCDD"}""",
    ];

    private string SeedDebrisWithTwoModelsCarryingBlobs()
    {
        var created = Service().CreateRecord(_mod.Plugin, "debr", DebrisEditorId);
        Assert.True(created.Applied, created.Message);

        var seed = Service().EditField(_mod.Plugin, created.NewFormKey!, "models",
            Json("[" + string.Join(",", TwoModels) + "]"));
        Assert.True(seed.Applied, seed.Message);
        return created.NewFormKey!;
    }

    private string DebrisBody(string formKey) =>
        _mod.Mirror.Index!.At(Core.Records.RecordRef.Effective).GetDocument(formKey, _mod.Plugin)!.Body!;

    [Fact]
    public void ArrayRemove_OnAListWhoseElementsCarryAByteSlice_LeavesTheSurvivorsBlobUntouched()
    {
        var debris = SeedDebrisWithTwoModelsCarryingBlobs();
        Assert.Contains("0xAABBCCDD", DebrisBody(debris), StringComparison.Ordinal);

        var result = Service().EditField(_mod.Plugin, debris, "models",
            Json("""{"op": "array_remove", "path": [{"kind": "index", "index": 0}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = DebrisBody(debris);
        Assert.DoesNotContain("0x1122", body, StringComparison.Ordinal);
        Assert.Contains("0xAABBCCDD", body, StringComparison.Ordinal);
    }

    [Fact]
    public void ArrayMoveUp_OnAListWhoseElementsCarryAByteSlice_KeepsBothBlobs()
    {
        var debris = SeedDebrisWithTwoModelsCarryingBlobs();

        var result = Service().EditField(_mod.Plugin, debris, "models",
            Json("""{"op": "array_move_up", "path": [{"kind": "index", "index": 1}]}"""));

        Assert.True(result.Applied, result.Message);
        var body = DebrisBody(debris);
        Assert.Contains("0x1122", body, StringComparison.Ordinal);
        Assert.Contains("0xAABBCCDD", body, StringComparison.Ordinal);
    }
}
