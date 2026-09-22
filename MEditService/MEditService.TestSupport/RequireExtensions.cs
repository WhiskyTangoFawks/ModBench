namespace MEditService.TestSupport;

/// <summary>A value a test just built or a fixture just wrote: missing here is a broken fixture,
/// not a case under test.</summary>
public static class RequireExtensions
{
    public static T Require<T>(this T? value) where T : class =>
        value ?? throw new InvalidOperationException($"Expected a non-null {typeof(T).Name} here; the fixture does not hold what the test built.");
}
