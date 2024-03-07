module.exports = {
	rules: {
		semi: 'error',
		'prefer-const': 'error',
	},

	overrides: [
		{
			files: ['app/ts/**/*.ts', 'app/ts/**/*.tsx'],
			parserOptions: {
				project: './tsconfig.json',
			},
		},
	],
}
