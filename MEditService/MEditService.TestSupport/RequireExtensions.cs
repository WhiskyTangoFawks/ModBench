using MEditService.PluginAdapter;

namespace MEditService.TestSupport;

/// <summary>A value a test just built or a fixture just wrote: missing here is a broken fixture,
/// not a case under test.</summary>
public static class RequireExtensions
{
    public static T Require<T>(this T? value) where T : class =>
        value ?? throw new InvalidOperationException($"Expected a non-null {typeof(T).Name} here; the fixture does not hold what the test built.");

    /// <summary>The value a plugin read or write answered; its failure here is a broken fixture.</summary>
    public static T Answered<T>(this PluginAnswer<T> answer) =>
        answer.Holds(out var value, out var failure)
            ? value
            : throw new InvalidOperationException($"Expected the plugin adapter to answer here: {failure.Reason}");

    /// <summary>A double's answer in place of <paramref name="answer"/>'s value, its failure passed on.</summary>
    public static PluginAnswer<TOut> Map<T, TOut>(this PluginAnswer<T> answer, Func<T, TOut> map) =>
        answer.Holds(out var value, out var failure) ? PluginAnswer.Of(map(value)) : failure;

    /// <summary>A double's answer of a value it makes.</summary>
    public static PluginAnswer<T> AnswerOf<T>(Func<T> make) => PluginAnswer.Of(make());

    /// <summary>The failure a plugin read or write answered, which the test asked for.</summary>
    public static PluginFailure Failure<T>(this PluginAnswer<T> answer) =>
        answer.Holds(out _, out var failure)
            ? throw new InvalidOperationException("Expected the plugin adapter to answer a failure here.")
            : failure;
}
