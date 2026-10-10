namespace MEditService.Codec.Game;

/// <summary>A condition's Run On, alike in every game whose conditions have one.</summary>
internal static class RunOnAnnotations
{
    /// <summary>The <c>Reference</c> member carries a target only for the one Run On value that
    /// names one; under every other value it is unread, and xEdit shows no reference row.</summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Reference { get; } =
        Enum.GetNames<Condition.RunOnType>().ToDictionary(
            name => name,
            name => name == nameof(Condition.RunOnType.Reference)
                ? (IReadOnlyList<string>)[nameof(ConditionData.Reference)]
                : []);
}
