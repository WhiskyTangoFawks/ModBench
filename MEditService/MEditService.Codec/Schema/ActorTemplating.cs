using System.Globalization;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Codec.Schema;

/// <summary>Which members each template flag hands to a template, and the template it names: its own
/// slot, else the default. Paths are dotted document paths from the record's root.</summary>
public sealed record ActorTemplating(
    string TypeName,
    string FlagsMember,
    string DefaultTemplate,
    IReadOnlyDictionary<string, string> Slots,
    IReadOnlyDictionary<string, string> FlagOfMember)
{
    private const string UnsetLink = "Null";

    private Dictionary<string, long> FlagBits { get; init; } = [];

    internal ActorTemplating WithFlagBitsOf(Type actor) => this with
    {
        FlagBits = ReflectedTypes.PropertyAt(actor, FlagsMember) is { } flags && ReflectedTypes.CoreOf(flags).Core is { IsEnum: true } flagsEnum
            ? Enum.GetNames(flagsEnum).ToDictionary(name => name, name => Convert.ToInt64(Enum.Parse(flagsEnum, name), CultureInfo.InvariantCulture), StringComparer.Ordinal)
            : throw new InvalidOperationException($"Expected {actor.Name} to reach a flags enum at {FlagsMember}."),
    };

    /// <summary>The members the document hands to a template, by path; null where it hands over none.</summary>
    internal IReadOnlyDictionary<string, TemplatedBy>? In(
        Document document, Func<string, ResolvedFormKey?> resolve, GameRelease release)
    {
        var templates = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var flag in FlagsSetIn(document))
        {
            if ((LinkAt(document, Slots.GetValueOrDefault(flag)) ?? LinkAt(document, DefaultTemplate)) is { } template)
                templates[flag] = template;
        }
        var templated = FlagOfMember
            .Where(member => templates.ContainsKey(member.Value))
            .ToDictionary(
                member => member.Key,
                member => new TemplatedBy(
                    member.Value,
                    templates[member.Value],
                    FormKeyResolution.From(templates[member.Value], resolve(templates[member.Value]), [], release)),
                StringComparer.Ordinal);
        return templated.Count > 0 ? templated : null;
    }

    // NewtonsoftJsonSerializationWriterKernel.WriteEnum (mutagen-serialization).
    private IEnumerable<string> FlagsSetIn(Document document) => document.At(FlagsMember.Split('.')) switch
    {
        { ValueKind: JsonValueKind.Array } names => names.EnumerateArray().Select(name => name.GetString()).OfType<string>(),
        { ValueKind: JsonValueKind.String } value when value.GetString() is { } name && FlagBits.ContainsKey(name) => [name],
        { ValueKind: JsonValueKind.String } value when long.TryParse(value.GetString(), CultureInfo.InvariantCulture, out var bits) =>
            FlagBits.Where(flag => (bits & flag.Value) != 0).Select(flag => flag.Key),
        _ => [],
    };

    private static string? LinkAt(Document document, string? path) =>
        path is not null && document.StringAt(path.Split('.')) is { } link && link != UnsetLink ? link : null;
}

/// <summary>The flag that hands a member to a template, and that template.</summary>
public sealed record TemplatedBy(string Flag, string Template, FormKeyResolution Resolution);
