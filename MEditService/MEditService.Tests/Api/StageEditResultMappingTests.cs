using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using Microsoft.AspNetCore.Http;

namespace MEditService.Tests.Api;

public sealed class StageEditResultMappingTests
{
    private static ReferenceValidationError MakeError() =>
        new("factions[0].faction", "000001:X.esp", "type_mismatch", ["fact"]);

    [Fact]
    public void InvalidReferences_MapsTo422WithErrors()
    {
        var errors = new[] { MakeError() };
        var result = new StageEditResult.InvalidReferences(errors).ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(422, status.StatusCode);

        var value = Assert.IsAssignableFrom<IValueHttpResult>(result);
        Assert.Equal(errors, value.Value);
    }

    [Fact]
    public void NoSession_MapsTo500Problem()
    {
        var result = new StageEditResult.NoSession().ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(500, status.StatusCode);
    }

    [Fact]
    public void PluginImmutable_MapsTo409Problem()
    {
        var result = new StageEditResult.PluginImmutable("Fallout4.esm").ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(409, status.StatusCode);
    }

    [Fact]
    public void BlockedByGroup_MapsTo409Problem()
    {
        var result = new StageEditResult.BlockedByGroup(Guid.NewGuid()).ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(409, status.StatusCode);
    }

    [Fact]
    public void RecordNotFound_MapsTo404()
    {
        var result = new StageEditResult.RecordNotFound().ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(404, status.StatusCode);
    }

    [Fact]
    public void ReadOnlyFields_MapsTo422Problem()
    {
        var result = new StageEditResult.ReadOnlyFields(["form_key"]).ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(422, status.StatusCode);
    }

    [Fact]
    public void Staged_MapsTo200WithChanges()
    {
        var changes = Array.Empty<PendingChange>();
        var result = new StageEditResult.Staged(changes).ToHttpResult();

        var status = Assert.IsAssignableFrom<IStatusCodeHttpResult>(result);
        Assert.Equal(200, status.StatusCode);
    }
}
