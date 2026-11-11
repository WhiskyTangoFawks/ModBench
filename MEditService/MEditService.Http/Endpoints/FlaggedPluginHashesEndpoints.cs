using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;

namespace MEditService.Http.Endpoints;

internal static class FlaggedPluginHashesEndpoints
{
    public static IEndpointRouteBuilder MapFlaggedPluginHashesEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/plugin-files/flagged-hashes", FlaggedHashes)
            .WithName("GetFlaggedPluginHashes")
            .WithTags("Mods")
            .WithDescription(
                "Each plugin file's hashes, by its absolute path, as a manifest carries them, with each named load flag at each " +
                "combination of its possible original values; none when the file does not hold a named flag as the request sets it. " +
                "A file that is no plugin could not have held a package's copy, so its hashes are none. Writes nothing. 400 when a file cannot " +
                "be read or a name is no load flag of the game.")
            .Produces<IReadOnlyList<FlaggedPluginHashes>>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult FlaggedHashes(FlaggedPluginHashesRequest req)
    {
        if (EndpointMapping.ParseGameRelease(req.GameRelease, out var release) is { } releaseErr) return releaseErr;
        if (req.Files is not { Count: > 0 } files || files.Any(file => string.IsNullOrWhiteSpace(file.Path) || file.Flags is not { Count: > 0 }))
            return EndpointMapping.BadRequest("At least one file is required, and every file needs a path and at least one flag.");

        var known = GameCodecs.For(release).LoadFlags;
        List<FlaggedPluginHashes> answered = [];
        foreach (var file in files)
        {
            if (file.Flags.Keys.FirstOrDefault(name => !known.ContainsKey(name)) is { } unknown)
                return EndpointMapping.BadRequest($"'{unknown}' is no load flag of {release}");
            if (!PluginOriginalHashes.Of(file.Path, file.Flags, release).Holds(out var hashes, out var failure))
                return EndpointMapping.BadRequest($"{file.Path}: {failure.Reason}");
            answered.Add(new FlaggedPluginHashes(file.Path, hashes));
        }

        return Results.Ok(answered);
    }
}

/// <summary>The plugin files, by absolute path, with the load flags the manifest sets in each, and the release whose
/// flags they are.</summary>
internal sealed record FlaggedPluginHashesRequest(string GameRelease, IReadOnlyList<FlaggedPluginFile> Files);

internal sealed record FlaggedPluginFile(string Path, IReadOnlyDictionary<string, bool> Flags);

/// <summary>A plugin file's hashes with its flags at their possible original values.</summary>
internal sealed record FlaggedPluginHashes(string Path, IReadOnlyList<string> Hashes);
